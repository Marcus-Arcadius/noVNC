/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import * as Log from './util/logging.js';
import Base64 from "./base64.js";
import { toSigned32bit } from './util/int.js';

export default class Display {
    constructor(target) {
        this._drawCtx = null;

        this._renderQ = [];  // queue drawing actions for in-oder rendering
        this._flushing = false;

        // the full frame buffer (logical canvas) size
        this._fbWidth = 0;
        this._fbHeight = 0;

        this._renderMs = 0;

        this._prevDrawStyle = "";

        Log.Debug(">> Display.constructor");

        // The visible canvas
        this._target = target;

        if (!this._target) {
            throw new Error("Target must be set");
        }

        if (typeof this._target === 'string') {
            throw new Error('target must be a DOM element');
        }

        if (!this._target.getContext) {
            throw new Error("no getContext method");
        }

        this._targetCtx = this._target.getContext('2d');

        // the visible canvas viewport (i.e. what actually gets seen)
        this._viewportLoc = { 'x': 0, 'y': 0, 'w': this._target.width, 'h': this._target.height };

        // The hidden canvas, where we do the actual rendering
        this._backbuffer = document.createElement('canvas');
        this._drawCtx = this._backbuffer.getContext('2d');

        this._damageBounds = { left: 0, top: 0,
                               right: this._backbuffer.width,
                               bottom: this._backbuffer.height };

        Log.Debug("User Agent: " + navigator.userAgent);

        // performance metrics, try to calc a fps equivelant
        this._flipCnt = 0;
        this._currentFrameDamages = [];
        this._lastFlip = Date.now();
        setInterval(function() {
            let delta = Date.now() - this._lastFlip;
            if (delta > 0) {
                this._fps = (this._flipCnt / (delta / 1000)).toFixed(2);
            }
            this._lastFlip = Date.now();
            this._flipCnt = 0;
        }.bind(this), 5000);

        Log.Debug("<< Display.constructor");

        // ===== PROPERTIES =====

        this._scale = 1.0;
        this._clipViewport = false;
        this._antiAliasing = 0;
        this._fps = 0;

        // ===== EVENT HANDLERS =====

        this.onflush = () => {  }; // A flush request has finished
    }

    // ===== PROPERTIES =====
    
    get antiAliasing() { return this._antiAliasing; }
    set antiAliasing(value) {
        this._antiAliasing = value;
        this._rescale(this._scale);
    }

    get scale() { return this._scale; }
    set scale(scale) {
        this._rescale(scale);
    }

    get clipViewport() { return this._clipViewport; }
    set clipViewport(viewport) {
        this._clipViewport = viewport;
        // May need to readjust the viewport dimensions
        const vp = this._viewportLoc;
        this.viewportChangeSize(vp.w, vp.h);
        this.viewportChangePos(0, 0);
    }

    get width() {
        return this._fbWidth;
    }

    get height() {
        return this._fbHeight;
    }

    get renderMs() {
        return this._renderMs;
    }
    set renderMs(val) {
        this._renderMs = val;
    }

    get fps() { return this._fps; }

    // ===== PUBLIC METHODS =====

    viewportChangePos(deltaX, deltaY) {
        const vp = this._viewportLoc;
        deltaX = Math.floor(deltaX);
        deltaY = Math.floor(deltaY);

        if (!this._clipViewport) {
            deltaX = -vp.w;  // clamped later of out of bounds
            deltaY = -vp.h;
        }

        const vx2 = vp.x + vp.w - 1;
        const vy2 = vp.y + vp.h - 1;

        // Position change

        if (deltaX < 0 && vp.x + deltaX < 0) {
            deltaX = -vp.x;
        }
        if (vx2 + deltaX >= this._fbWidth) {
            deltaX -= vx2 + deltaX - this._fbWidth + 1;
        }

        if (vp.y + deltaY < 0) {
            deltaY = -vp.y;
        }
        if (vy2 + deltaY >= this._fbHeight) {
            deltaY -= (vy2 + deltaY - this._fbHeight + 1);
        }

        if (deltaX === 0 && deltaY === 0) {
            return;
        }
        Log.Debug("viewportChange deltaX: " + deltaX + ", deltaY: " + deltaY);

        vp.x += deltaX;
        vp.y += deltaY;

        this._damage(vp.x, vp.y, vp.w, vp.h);

        this.flip();
    }

    viewportChangeSize(width, height) {

        if (!this._clipViewport ||
            typeof(width) === "undefined" ||
            typeof(height) === "undefined") {

            Log.Debug("Setting viewport to full display region");
            width = this._fbWidth;
            height = this._fbHeight;
        }

        width = Math.floor(width);
        height = Math.floor(height);

        if (width > this._fbWidth) {
            width = this._fbWidth;
        }
        if (height > this._fbHeight) {
            height = this._fbHeight;
        }

        const vp = this._viewportLoc;
        if (vp.w !== width || vp.h !== height) {
            vp.w = width;
            vp.h = height;

            const canvas = this._target;
            canvas.width = width;
            canvas.height = height;

            // The position might need to be updated if we've grown
            this.viewportChangePos(0, 0);

            this._damage(vp.x, vp.y, vp.w, vp.h);
            this.flip();

            // Update the visible size of the target canvas
            this._rescale(this._scale);
        }
    }

    absX(x) {
        if (this._scale === 0) {
            return 0;
        }
        return toSigned32bit(x / this._scale + this._viewportLoc.x);
    }

    absY(y) {
        if (this._scale === 0) {
            return 0;
        }
        return toSigned32bit(y / this._scale + this._viewportLoc.y);
    }

    resize(width, height) {
        this._prevDrawStyle = "";

        this._fbWidth = width;
        this._fbHeight = height;

        const canvas = this._backbuffer;
        if (canvas.width !== width || canvas.height !== height) {

            // We have to save the canvas data since changing the size will clear it
            let saveImg = null;
            if (canvas.width > 0 && canvas.height > 0) {
                saveImg = this._drawCtx.getImageData(0, 0, canvas.width, canvas.height);
            }

            if (canvas.width !== width) {
                canvas.width = width;
            }
            if (canvas.height !== height) {
                canvas.height = height;
            }

            if (saveImg) {
                this._drawCtx.putImageData(saveImg, 0, 0);
            }
        }

        // Readjust the viewport as it may be incorrectly sized
        // and positioned
        const vp = this._viewportLoc;
        this.viewportChangeSize(vp.w, vp.h);
        this.viewportChangePos(0, 0);
    }

    // Track what parts of the visible canvas that need updating
    _damage(x, y, w, h) {
        if (x < this._damageBounds.left) {
            this._damageBounds.left = x;
        }
        if (y < this._damageBounds.top) {
            this._damageBounds.top = y;
        }
        if ((x + w) > this._damageBounds.right) {
            this._damageBounds.right = x + w;
        }
        if ((y + h) > this._damageBounds.bottom) {
            this._damageBounds.bottom = y + h;
        }
    }

    // Attempt to determine when updates overlap an area and thus indicate a new frame
    isNewFrame(x, y, w, h) {
        for (var i = 0; i < this._currentFrameDamages.length; i++) {
            let area = this._currentFrameDamages[i];
            if (x >= area.x && x <= (area.x + area.w) && y >= area.y && y <= (area.y + area.h)) {
                this._currentFrameDamages = [];
                return true;
            }
        }

        var new_area = { x: x, y: y, w: w, h: h }
        this._currentFrameDamages.push(new_area);
        return false;
    }

    // Update the visible canvas with the contents of the
    // rendering canvas
    flip(fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'flip'
            });
        } else {
            let x = this._damageBounds.left;
            let y = this._damageBounds.top;
            let w = this._damageBounds.right - x;
            let h = this._damageBounds.bottom - y;

            let vx = x - this._viewportLoc.x;
            let vy = y - this._viewportLoc.y;

            if (vx < 0) {
                w += vx;
                x -= vx;
                vx = 0;
            }
            if (vy < 0) {
                h += vy;
                y -= vy;
                vy = 0;
            }

            if ((vx + w) > this._viewportLoc.w) {
                w = this._viewportLoc.w - vx;
            }
            if ((vy + h) > this._viewportLoc.h) {
                h = this._viewportLoc.h - vy;
            }

            if ((w > 0) && (h > 0)) {
                // FIXME: We may need to disable image smoothing here
                //        as well (see copyImage()), but we haven't
                //        noticed any problem yet.
                this._targetCtx.drawImage(this._backbuffer,
                                          x, y, w, h,
                                          vx, vy, w, h);

                this._flipCnt += 1;
            }
	  
            this._damageBounds.left = this._damageBounds.top = 65535;
            this._damageBounds.right = this._damageBounds.bottom = 0;
        }
    }

    pending() {
        return this._renderQ.length > 0;
    }

    flush() {
        if (this._renderQ.length === 0) {
            this.onflush();
        } else {
            this._flushing = true;
        }
    }

    fillRect(x, y, width, height, color, fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'fill',
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'color': color
            });
        } else {
            this._setFillColor(color);
            this._drawCtx.fillRect(x, y, width, height);
            this._damage(x, y, width, height);
        }
    }

    copyImage(oldX, oldY, newX, newY, w, h, fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'copy',
                'oldX': oldX,
                'oldY': oldY,
                'x': newX,
                'y': newY,
                'width': w,
                'height': h,
            });
        } else {
            // Due to this bug among others [1] we need to disable the image-smoothing to
            // avoid getting a blur effect when copying data.
            //
            // 1. https://bugzilla.mozilla.org/show_bug.cgi?id=1194719
            //
            // We need to set these every time since all properties are reset
            // when the the size is changed
            this._drawCtx.mozImageSmoothingEnabled = false;
            this._drawCtx.webkitImageSmoothingEnabled = false;
            this._drawCtx.msImageSmoothingEnabled = false;
            this._drawCtx.imageSmoothingEnabled = false;

            this._drawCtx.drawImage(this._backbuffer,
                                    oldX, oldY, w, h,
                                    newX, newY, w, h);
            this._damage(newX, newY, w, h);
        }
    }

    imageRect(x, y, width, height, mime, arr) {
        /* The internal logic cannot handle empty images, so bail early */
        if ((width === 0) || (height === 0)) {
            return;
        }

        const img = new Image();
        img.src = "data: " + mime + ";base64," + Base64.encode(arr);

        this._renderQPush({
            'type': 'img',
            'img': img,
            'x': x,
            'y': y,
            'width': width,
            'height': height
        });
    }

    blitImage(x, y, width, height, arr, offset, fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            // NB(directxman12): it's technically more performant here to use preallocated arrays,
            // but it's a lot of extra work for not a lot of payoff -- if we're using the render queue,
            // this probably isn't getting called *nearly* as much
            const newArr = new Uint8Array(width * height * 4);
            newArr.set(new Uint8Array(arr.buffer, 0, newArr.length));
            this._renderQPush({
                'type': 'blit',
                'data': newArr,
                'x': x,
                'y': y,
                'width': width,
                'height': height,
            });
        } else {
            // NB(directxman12): arr must be an Type Array view
            let data = new Uint8ClampedArray(arr.buffer,
                                             arr.byteOffset + offset,
                                             width * height * 4);
            let img = new ImageData(data, width, height);
            this._drawCtx.putImageData(img, x, y);
            this._damage(x, y, width, height);
        }
    }

    drawImage(img, x, y, w, h) {
        try {
	    if (img.width != w || img.height != h) {
                this._drawCtx.drawImage(img, x, y, w, h);
            } else {
                this._drawCtx.drawImage(img, x, y);
            }
        } catch (error) {
            Log.Error('Invalid image recieved.'); //KASM-2090
        }
        this._damage(x, y, w, h);
    }

    autoscale(containerWidth, containerHeight, scaleRatio=0) {

        if (containerWidth === 0 || containerHeight === 0) {
            scaleRatio = 0;

        } else if (scaleRatio === 0) {

            const vp = this._viewportLoc;
            const targetAspectRatio = containerWidth / containerHeight;
            const fbAspectRatio = vp.w / vp.h;

            if (fbAspectRatio >= targetAspectRatio) {
                scaleRatio = containerWidth / vp.w;
            } else {
                scaleRatio = containerHeight / vp.h;
            }
        }

        this._rescale(scaleRatio);
    }

    // ===== PRIVATE METHODS =====

    _rescale(factor) {
        this._scale = factor;
        const vp = this._viewportLoc;

        // NB(directxman12): If you set the width directly, or set the
        //                   style width to a number, the canvas is cleared.
        //                   However, if you set the style width to a string
        //                   ('NNNpx'), the canvas is scaled without clearing.
        const width = factor * vp.w + 'px';
        const height = factor * vp.h + 'px';

        if ((this._target.style.width !== width) ||
            (this._target.style.height !== height)) {
            this._target.style.width = width;
            this._target.style.height = height;
        }

        Log.Info('Pixel Ratio: ' + window.devicePixelRatio + ', VNC Scale: ' + factor + 'VNC Res: ' + vp.w + 'x' + vp.h);

        var pixR = Math.abs(Math.ceil(window.devicePixelRatio));
        var isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

        if (this.antiAliasing === 2 || (this.antiAliasing === 0 && factor === 1 && this._target.style.imageRendering !== 'pixelated' && pixR === window.devicePixelRatio && vp.w > 0)) {
            this._target.style.imageRendering = ((!isFirefox) ? 'pixelated' : 'crisp-edges' );
            Log.Debug('Smoothing disabled');
        } else if (this.antiAliasing === 1 || (this.antiAliasing === 0 && factor !== 1 && this._target.style.imageRendering !== 'auto')) {
            this._target.style.imageRendering = 'auto'; //auto is really smooth (blurry) using trilinear of linear
            Log.Debug('Smoothing enabled');
        }
    }

    _setFillColor(color) {
        const newStyle = 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')';
        if (newStyle !== this._prevDrawStyle) {
            this._drawCtx.fillStyle = newStyle;
            this._prevDrawStyle = newStyle;
        }
    }

    _renderQPush(action) {
        this._renderQ.push(action);
        if (this._renderQ.length === 1) {
            // If this can be rendered immediately it will be, otherwise
            // the scanner will wait for the relevant event
            this._scanRenderQ();
        }
    }

    _resumeRenderQ() {
        // "this" is the object that is ready, not the
        // display object
        this.removeEventListener('load', this._noVNCDisplay._resumeRenderQ);
        this._noVNCDisplay._scanRenderQ();
    }

    _scanRenderQ() {
        let ready = true;
        let before = Date.now();
        while (ready && this._renderQ.length > 0) {
            const a = this._renderQ[0];
            switch (a.type) {
                case 'flip':
                    this.flip(true);
                    break;
                case 'copy':
                    this.copyImage(a.oldX, a.oldY, a.x, a.y, a.width, a.height, true);
                    break;
                case 'fill':
                    this.fillRect(a.x, a.y, a.width, a.height, a.color, true);
                    break;
                case 'blit':
                    this.blitImage(a.x, a.y, a.width, a.height, a.data, 0, true);
                    break;
                case 'img':
                    if (a.img.complete) {
                        /* if (a.img.width !== a.width || a.img.height !== a.height) {
                            Log.Error("Decoded image has incorrect dimensions. Got " +
                                      a.img.width + "x" + a.img.height + ". Expected " +
                                      a.width + "x" + a.height + ".");
                            return;
                        }*/
                        this.drawImage(a.img, a.x, a.y, a.width, a.height);
                    } else {
                        a.img._noVNCDisplay = this;
                        a.img.addEventListener('load', this._resumeRenderQ);
                        // We need to wait for this image to 'load'
                        // to keep things in-order
                        ready = false;
                    }
                    break;
            }

            if (ready) {
                this._renderQ.shift();
            }
        }

        if (this._renderQ.length === 0 && this._flushing) {
            this._flushing = false;
            this.onflush();
        }

        let elapsed = Date.now() - before;
        this._renderMs += elapsed;
    }
}
