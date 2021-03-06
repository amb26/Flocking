/*! Flocking 0.1, Copyright 2012 Colin Clark | flockingjs.org */

/*
* Flocking - Creative audio synthesis for the Web!
* http://github.com/colinbdclark/flocking
*
* Copyright 2012, Colin Clark
* Dual licensed under the MIT and GPL Version 2 licenses.
*/

/*global Float32Array, window, jQuery*/
/*jslint white: true, vars: true, undef: true, newcap: true, regexp: true, browser: true,
    forin: true, continue: true, nomen: true, bitwise: true, maxerr: 100, indent: 4 */

var fluid = fluid || require("infusion"),
    flock = fluid.registerNamespace("flock");

(function () {
    "use strict";

    var $ = fluid.registerNamespace("jQuery");
    
    flock.init = function (options) {
        var enviroOpts = !options ? undefined : {
            audioSettings: options
        };
        flock.enviro.shared = flock.enviro(enviroOpts);
    };
    
    flock.OUT_UGEN_ID = "flocking-out";
    flock.TWOPI = 2.0 * Math.PI;
    flock.LOG01 = Math.log(0.1);
    flock.LOG001 = Math.log(0.001);
    flock.ROOT2 = Math.sqrt(2);
    
    flock.rates = {
        AUDIO: "audio",
        CONTROL: "control",
        DEMAND: "demand",
        CONSTANT: "constant"
    };
    
    flock.sampleFormats = {
        FLOAT32NE: "float32NE"
    };

    flock.browser = function () {
        if (typeof (navigator) === "undefined") {
            return {};
        }

        // This is a modified version of jQuery's browser detection code,
        // which they removed from jQuery 2.0.
        // Some of us still have to live in the messy reality of the web.
        var ua = navigator.userAgent.toLowerCase(),
            browser = {},
            match,
            matched;
        
        match = /(chrome)[ \/]([\w.]+)/.exec( ua ) ||
            /(webkit)[ \/]([\w.]+)/.exec( ua ) ||
            /(opera)(?:.*version|)[ \/]([\w.]+)/.exec( ua ) ||
            /(msie) ([\w.]+)/.exec( ua ) ||
            ua.indexOf("compatible") < 0 && /(mozilla)(?:.*? rv:([\w.]+)|)/.exec( ua ) || [];
        
        matched = {
            browser: match[ 1 ] || "",
            version: match[ 2 ] || "0"
        };

        if (matched.browser) {
            browser[matched.browser] = true;
            browser.version = matched.version;
        }

        // Chrome is Webkit, but Webkit is also Safari.
        if ( browser.chrome ) {
            browser.webkit = true;
        } else if ( browser.webkit ) {
            browser.safari = true;
        }
        
        return browser;
    };
    
    // TODO: Move to components in the static environment and into the appropriate platform files.
    fluid.registerNamespace("flock.platform");
    flock.platform.isBrowser = typeof (window) !== "undefined";
    flock.platform.os = flock.platform.isBrowser ? window.navigator.platform : fluid.require("os").platform();
    flock.platform.isLinuxBased = flock.platform.os.indexOf("Linux") > -1 || flock.platform.os.indexOf("Android") > -1;
    flock.platform.browser = flock.browser();
    flock.platform.isWebAudio = (typeof (AudioContext) !== "undefined" && (new AudioContext()).createJavaScriptNode) ||
        typeof (webkitAudioContext) !== "undefined";
    flock.platform.audioEngine = flock.platform.isBrowser ? (flock.platform.isWebAudio ? "webAudio" : "moz") : "nodejs";
    fluid.staticEnvironment.audioEngine = fluid.typeTag("flock.platform." + flock.platform.audioEngine);

    
    /*************
     * Utilities *
     *************/
    
    flock.isIterable = function (o) {
        return o && o.length !== undefined && typeof (o.length) === "number";
    };

    flock.generate = function (bufOrSize, generator) {
        var buf = typeof (bufOrSize) === "number" ? new Float32Array(bufOrSize) : bufOrSize,
            i;

        if (typeof (generator) === "number") {
            var value = generator;
            generator = function () { 
                return value; 
            };
        }
        
        for (i = 0; i < buf.length; i++) {
            buf[i] = generator(i, buf);
        }

        return buf;
    };
    
    flock.generate.silence = function (bufOrSize) {
        if (typeof (bufOrSize) === "number") {
            return new Float32Array(bufOrSize);
        }
        
        var buf = bufOrSize,
            i;
        for (i = 0; i < buf.length; i++) {
            buf[i] = 0.0;
        }
        return buf;
    };
     
    flock.minBufferSize = function (latency, audioSettings) {
        var size = (audioSettings.rates.audio * audioSettings.chans) / (1000 / latency);
        return Math.round(size);
    };
    
    /**
     * Randomly selects an index from the specified array.
     */
    flock.randomIndex = function (arr) {
        var max = arr.length - 1;
        return Math.round(Math.random() * max);
    };

    /**
     * Randomly selects an item from an array-like object.
     *
     * @param {Array-like object} arr the array to choose from
     * @param {Function} a selection strategy; defaults to flock.randomIndex
     * @return a randomly selected list item
     */
    flock.arrayChoose = function (arr, strategy) {
        strategy = strategy || flock.randomIndex;
        arr = fluid.makeArray(arr);
        var idx = strategy(arr);
        return arr[idx];
    };

    /**
     * Randomly selects an item from an array or object.
     *
     * @param {Array-like object|Object} collection the object to choose from
     * @return a randomly selected item from collection
     */
    flock.choose = function (collection, strategy) {
        if (flock.isIterable(collection)) {
            var val = flock.arrayChoose(collection, strategy);
            return val;
        }

        var key = flock.arrayChoose(collection.keys, strategy);
        return collection[key];
    };
    
    /**
     * Normalizes the specified buffer in place to the specified value.
     *
     * @param {Arrayable} buffer the buffer to normalize; it will not be copied
     * @param {Number} normal the value to normalize the buffer to
     * @return the buffer, normalized in place
     */
    flock.normalize = function (buffer, normal) {
        var maxVal = 0.0,
            i,
            current,
            val;
        
        normal = normal === undefined ? 1.0 : normal;
        // Find the maximum value in the buffer.
        for (i = 0; i < buffer.length; i++) {
            current = Math.abs(buffer[i]);
            if (current > maxVal) {
                maxVal = current;
            }
        }
        
        // And then normalize the buffer in place.
        if (maxVal > 0.0) {
            for (i = 0; i < buffer.length; i++) {
                val = buffer[i];
                buffer[i] = (val / maxVal) * normal;
            }
        }
        
        return buffer;
    };
    
    flock.range = function (buf) {
        var range = {
            max: Number.NEGATIVE_INFINITY,
            min: Infinity
        };
        var i, val;
        
        for (i = 0; i < buf.length; i++) {
            val = buf[i];
            if (val > range.max) {
                range.max = val;
            }
            if (val < range.min) {
                range.min = val;
            }
        }
        
        return range;
    };
    
    flock.scale = function (buf, minVal, maxVal) {
        if (!buf) {
            return;
        }
        
        var range = flock.range(buf),
            mul = (range.max - range.min) / 2,
            sub = (range.max + range.min) / 2,
            i;
        
        for (i = 0; i < buf.length; i++) {
            buf[i] = (buf[i] - sub) / mul;
        }
        
        return buf;
    };
    
    flock.copyBuffer = function (buffer, start, end) {
        if (end === undefined) {
            end = buffer.length;
        }
        
        var len = end - start,
            target = new Float32Array(len),
            i,
            j;
        
        for (i = start, j = 0; i < end; i++, j++) {
            target[j] = buffer[i];
        }
        
        return target;
    };
    
    
    flock.interpolate = {};
    
    /**
     * Performs linear interpretation.
     */
    flock.interpolate.linear = function (idx, table) {
        idx = idx % table.length;
        
        var i1 = idx | 0,
            i2 = (i1 + 1) % table.length,
            frac = idx - i1,
            y1 = table[i1],
            y2 = table[i2];
        
        return y1 + frac * (y2 - y1);
    };
    
    /**
     * Performs cubic interpretation.
     */
    flock.interpolate.cubic = function (idx, table) {
        idx = idx % table.length;
        
        var len = table.length,
            i1 = idx | 0,
            i0 = i1 > 0 ? i1 - 1 : len - 1,
            i2 = (i1 + 1) % len,
            i3 = (i1 + 2) % len,
            frac = idx - i1,
            fracSq = frac * frac,
            fracCub = frac * fracSq,
            y0 = table[i0],
            y1 = table[i1],
            y2 = table[i2],
            y3 = table[i3],
            a = 0.5 * (y1 - y2) + (y3 - y0),
            b = (y0 + y2) * 0.5 - y1,
            c = y2 - (0.3333333333333333 * y0) - (0.5 * y1) - (0.16666666666666667 * y3);
        
        return (a * fracCub) + (b * fracSq) + (c * frac) + y1;
    };
    
    
    flock.pathParseError = function (path, token) {
        throw new Error("Error parsing path: " + path + ". Segment '" + token + 
            "' could not be resolved.");
    };
    
    flock.get = function (root, path) {
        if (!root) {
            return fluid.getGlobalValue(path);
        } else if (arguments.length == 1 && typeof (root) === "string") {
            return fluid.getGlobalValue(root);
        }

        if (!path || path === "") {
            return;
        }
        
        var tokenized = path === "" ? [] : String(path).split("."),
            valForSeg = root[tokenized[0]],
            i;
        
        for (i = 1; i < tokenized.length; i++) {
            if (valForSeg === null || valForSeg === undefined) {
                flock.pathParseError(path, tokenized[i - 1]);
            }
            valForSeg = valForSeg[tokenized[i]];
        }
        return valForSeg;
    };
    
    flock.set = function (root, path, value) {
        if (!root || !path || path === "") {
            return;
        }
        
        var tokenized = String(path).split("."),
            l = tokenized.length,
            prop = tokenized[0],
            i,
            type;
            
        for (i = 1; i < l; i++) {
            root = root[prop];
            type = typeof (root);
            if (type !== "object") {
                throw new Error("A non-container object was found at segment " + prop + ". Value: " + root);
            }
            prop = tokenized[i];
            if (root[prop] === undefined) {
                root[prop] = {};
            }
        }
        root[prop] = value;
        
        return value;
    };
    
    flock.invoke = function (root, path, args) {
        var fn = typeof (root) === "function" ? root : flock.get(root, path);
        if (typeof (fn) !== "function") {
            throw new Error("Path '" + path + "' does not resolve to a function.");
        }
        return fn.apply(null, args);
    };

    
    flock.input = {};
    
    flock.input.pathExpander = function (path) {
        return path.replace(/\.(?![0-9])/g, ".inputs.");
    };
    
    flock.input.expandPaths = function (paths) {
        var expanded = {},
            path,
            expandedPath,
            value;
        
        for (path in paths) {
            expandedPath = flock.input.pathExpander(path);
            value = paths[path];
            expanded[expandedPath] = value;
        }

        return expanded;
    };
    
    flock.input.expandPath = function (path) {
        return (typeof (path) === "string") ? flock.input.pathExpander(path) : flock.input.expandPaths(path);
    };
    
    flock.input.getValueForPath = function (root, path) {
        path = flock.input.expandPath(path);
        var input = flock.get(root, path);
        // TODO: This algorithm needs to be made much clearer.
        return (input && !input.gen && input.model && typeof (input.model.value) !== "undefined") ?
            input.model.value : input;
    };
    
    flock.input.getValuesForPathArray = function (root, paths) {
        var values = {},
            i,
            path;
        
        for (i = 0; i < paths.length; i++) {
            path = paths[i];
            values[path] = flock.input.get(root, path);
        }
        
        return values;
    };
    
    flock.input.getValuesForPathObject = function (root, pathObj) {
        var key;
        
        for (key in pathObj) {
            pathObj[key] = flock.input.get(root, key);
        }
        
        return pathObj;
    };
    
    /**
     * Gets the value of the ugen at the specified path.
     *
     * @param {String} path the ugen's path within the synth graph
     * @return {Number|UGen} a scalar value in the case of a value ugen, otherwise the ugen itself
     */
    flock.input.get = function (root, path) {
        return typeof (path) === "string" ? flock.input.getValueForPath(root, path) :
            flock.isIterable(path) ? flock.input.getValuesForPathArray(root, path) :
            flock.input.getValuesForPathObject(root, path);
    };
    
    flock.input.setValueForPath = function (root, path, val, baseTarget, valueParser) {
        path = flock.input.expandPath(path);
        
        var previousInput = flock.get(root, path),
            lastDotIdx = path.lastIndexOf("."),
            inputName = path.slice(lastDotIdx + 1),
            target = lastDotIdx > -1 ? flock.get(root, path.slice(0, path.lastIndexOf(".inputs"))) : baseTarget,
            newInput = valueParser ? valueParser(val, path, target, previousInput) : val;
        
        flock.set(root, path, newInput);
        if (target && target.onInputChanged) {
            target.onInputChanged(inputName);
        }
        
        return newInput;
    };
    
    flock.input.setValuesForPaths = function (root, valueMap, baseTarget, valueParser) {
        var resultMap = {},
            path,
            val,
            result;
        
        for (path in valueMap) {
            val = valueMap[path];
            result = flock.input.set(root, path, val, baseTarget, valueParser);
            resultMap[path] = result;
        }
        
        return resultMap;
    };
    
    /**
     * Sets the value of the ugen at the specified path.
     *
     * @param {String} path the ugen's path within the synth graph
     * @param {Number || UGenDef} val a scalar value (for Value ugens) or a UGenDef object
     * @return {UGen} the newly created UGen that was set at the specified path
     */
    flock.input.set = function (root, path, val, baseTarget, valueParser) {
        return typeof (path) === "string" ?
            flock.input.setValueForPath(root, path, val, baseTarget, valueParser) :
            flock.input.setValuesForPaths(root, path, baseTarget, valueParser);
    };
    
    
    fluid.defaults("flock.nodeList", {
        gradeNames: ["fluid.littleComponent", "autoInit"],
        members: {
            nodes: [],
            namedNodes: {}
        }
    });
    
    flock.nodeList.preInit = function (that) {
        that.head = function (node) {
            that.nodes.unshift(node);
            that.namedNodes[node.nickName] = node;
        };
        
        that.before = function (refNode, node) {
            var refIdx = that.nodes.indexOf(refNode);
            that.at(refIdx, node);
        };
        
        that.after = function (refNode, node) {
            var refIdx = that.nodes.indexOf(refNode);
            that.at(refIdx + 1, node);
        };
        
        that.at = function (idx, node) {
            that.nodes.splice(idx, 0, node);
            that.namedNodes[node.nickName] = node;
        };
        
        that.tail = function (node) {
            that.nodes.push(node);
            that.namedNodes[node.nickName] = node;
        };
        
        that.remove = function (node) {
            var idx = that.nodes.indexOf(node);
            that.nodes.splice(idx, 1);
            delete that.namedNodes[node.nickName];
        };
    };
    
    
    /***********************
     * Synths and Playback *
     ***********************/
    
    fluid.defaults("flock.enviro", {
        gradeNames: ["fluid.modelComponent", "flock.nodeList", "autoInit"],
        model: {
            playState: {
                written: 0,
                total: null
            },
            
            isPlaying: false
        },
        audioSettings: {
            rates: {
                audio: 44100,
                control: 64,
                constant: 1
            },
            chans: 2,
            numBuses: 2,
            // This buffer size determines the overall latency of Flocking's audio output. On Firefox, it will be 2x.
            bufferSize: (flock.platform.os === "Win32" && flock.platform.browser.mozilla) ?
                16384: 2048,
            
            // Hints to some audio backends.
            genPollIntervalFactor: flock.platform.isLinuxBased ? 1 : 20 // Only used on Firefox.
        },
        components: {
            asyncScheduler: {
                type: "flock.scheduler.async"
            },
            
            audioStrategy: {
                type: "flock.enviro.audioStrategy",
                options: {
                    audioSettings: "{enviro}.options.audioSettings",
                    model: {
                        playState: "{enviro}.model.playState"
                    }
                }
            }
        }
    });
    
    flock.enviro.preInit = function (that) {
        that.audioSettings = that.options.audioSettings;
        that.buses = flock.enviro.createAudioBuffers(that.audioSettings.numBuses, 
                that.audioSettings.rates.control);
        that.buffers = {};
        
        /**
         * Starts generating samples from all synths.
         *
         * @param {Number} dur optional duration to play in seconds
         */
        that.play = function (dur) {
            dur = dur === undefined ? Infinity : dur;
            
            var playState = that.model.playState,
                sps = dur * that.audioSettings.rates.audio * that.audioSettings.chans;
                
            playState.total = playState.written + sps;
            that.audioStrategy.startGeneratingSamples();
            that.model.isPlaying = true;
        };
        
        /**
         * Stops generating samples from all synths.
         */
        that.stop = function () {
            that.audioStrategy.stopGeneratingSamples();
            that.model.isPlaying = false;
        };
        
        that.reset = function () {
            that.stop();
            that.asyncScheduler.clearAll();
            // Clear the environment's node list.
            while (that.nodes.length > 0) {
                that.nodes.pop();
            }
        };
        
        that.loadBuffer = function (name, src, onLoadFn) {
            // TODO: Replace with a promise.
            if (!src && onLoadFn) {
                // Assume the buffer has already been loaded by other means.
                onLoadFn(that.buffers[name], name);
                return;
            }
            
            flock.audio.decode(src, function (decoded) {
                var chans = decoded.data.channels;
                that.buffers[name] = chans;
                if (onLoadFn) {
                    onLoadFn(chans, name); 
                }
            });
        };
    };
    
    flock.enviro.finalInit = function (that) {
        that.gen = that.audioStrategy.nodeEvaluator.gen;
        
        // TODO: Model-based (with ChangeApplier) sharing of audioSettings
        that.options.audioSettings.rates.audio = that.audioStrategy.options.audioSettings.rates.audio;
    };
    
    flock.enviro.createAudioBuffers = function (numBufs, kr) {
        var bufs = [],
            i;
        for (i = 0; i < numBufs; i++) {
            bufs[i] = new Float32Array(kr);
        }
        return bufs;
    };
    
    fluid.defaults("flock.enviro.audioStrategy", {
        gradeNames: ["fluid.modelComponent"],
        
        components: {
            nodeEvaluator: {
                type: "flock.enviro.nodeEvaluator",
                options: {
                    numBuses: "{enviro}.options.audioSettings.numBuses",
                    controlRate: "{enviro}.options.audioSettings.rates.control",
                    members: {
                        buses: "{enviro}.buses",
                        nodes: "{enviro}.nodes"
                    }
                }
            }
        }
    });
    
    /*****************
     * Node Evalutor *
     *****************/
    
    fluid.defaults("flock.enviro.nodeEvaluator", {
        gradeNames: ["fluid.littleComponent", "autoInit"]
    });
    
    flock.enviro.nodeEvaluator.finalInit = function (that) {
        that.gen = function () {
            var numBuses = that.options.numBuses,
                busLen = that.options.controlRate,
                i,
                bus,
                j,
                node;
            
            // Clear all buses before evaluating the synth graph.
            for (i = 0; i < numBuses; i++) {
                bus = that.buses[i];
                for (j = 0; j < busLen; j++) {
                    bus[j] = 0;
                }
            }
            
            // Now evaluate each node.
            for (i = 0; i < that.nodes.length; i++) {
                node = that.nodes[i];
                node.gen(node.model.blockSize);
            }
        };
    };
    
    
    fluid.defaults("flock.autoEnviro", {
        gradeNames: ["fluid.littleComponent", "autoInit"]
    });
    
    flock.autoEnviro.preInit = function (that) {
        if (!flock.enviro.shared) {
            flock.init();
        }
    };
    
    
    fluid.defaults("flock.node", {
        gradeNames: ["flock.autoEnviro", "fluid.modelComponent", "autoInit"]
    });
    
    
    fluid.defaults("flock.synth", {
        gradeNames: ["flock.node", "autoInit"],
        mergePolicy: {
            synthDef: "nomerge"
        },
        components: {
            ugens: {
                type: "flock.synth.ugenCache"
            }
        },
        rate: flock.rates.AUDIO
    });
    
    /**
     * Synths represent a collection of signal-generating units, wired together to form an instrument.
     * They are created with a synthDef object, a declarative structure describing the synth's unit generator graph.
     */
    flock.synth.finalInit = function (that) {
        that.rate = that.options.rate;
        that.enviro = that.enviro || flock.enviro.shared;
        that.model.blockSize = that.enviro.audioSettings.rates.control;
        
        /**
         * Generates an audio rate signal by evaluating this synth's unit generator graph.
         *
         * @param numSamps the number of samples to generate
         * @return a buffer containing the generated audio
         */
        that.gen = function () {
            // TODO: Copy/pasted from nodeEvaluator.
            var nodes = that.ugens.active,
                i,
                node;
            
            for (i = 0; i < nodes.length; i++) {
                node = nodes[i];
                node.gen(node.model.blockSize);
            }
        };
        
        /**
         * Gets the value of the ugen at the specified path.
         *
         * @param {String} path the ugen's path within the synth graph
         * @return {Number|UGen} a scalar value in the case of a value ugen, otherwise the ugen itself
         */
        that.get = function (path) {
            return flock.input.get(that.ugens.named, path);
        };
        
        /**
         * Sets the value of the ugen at the specified path.
         *
         * @param {String} path the ugen's path within the synth graph
         * @param {Number || UGenDef} val a scalar value (for Value ugens) or a UGenDef object
         * @return {UGen} the newly created UGen that was set at the specified path
         */
        that.set = function (path, val, swap) {
            return flock.input.set(that.ugens.named, path, val, undefined, function (ugenDef, path, target, previous) {
                if (ugenDef === null || ugenDef === undefined) {
                    return previous;
                }
                
                var ugen = flock.parse.ugenDef(ugenDef, {
                    audioSettings: that.enviro.audioSettings,
                    buses: that.enviro.buses,
                    buffers: that.enviro.buffers
                });
                that.ugens.replace(ugen, previous, swap);
                return ugen;
            });
        };
        
        /**
         * Gets or sets the value of a ugen at the specified path
         *
         * @param {String} path the ugen's path within the synth graph
         * @param {Number || UGenDef || Array} val an optional value to to set--a scalar value, a UGenDef object, or an array of UGenDefs
         * @param {Boolean || Object} swap specifies if the existing inputs should be swapped onto the new value
         * @return {Number || UGenDef || Array} the value that was set or retrieved
         */
        that.input = function (path, val, swap) {
            return !path ? undefined : typeof (path) === "string" ?
                arguments.length < 2 ? that.get(path) : that.set(path, val, swap) :
                flock.isIterable(path) ? that.get(path) : that.set(path, val, swap);
        };
                
        /**
         * Plays the synth. This is a convenience method that will add the synth to the tail of the
         * environment's node graph and then play the environmnent.
         *
         * @param {Number} dur optional duration to play this synth in seconds
         */
        that.play = function () {
            var e = that.enviro;
            
            if (e.nodes.indexOf(that) === -1) {
                e.head(that);
            }
            
            if (!e.isPlaying) {
                e.play();
            }
        };
        
        /**
         * Stops the synth if it is currently playing.
         * This is a convenience method that will remove the synth from the environment's node graph.
         */
        that.pause = function () {
            that.enviro.remove(that);
        };

        that.init = function () {
            if (!that.options.synthDef) {
                fluid.log("Warning: Instantiating a flock.synth instance with an empty synth def.")
            }
            
            // Parse the synthDef into a graph of unit generators.
            that.out = flock.parse.synthDef(that.options.synthDef, {
                rate: that.options.rate,
                overrideRate: (that.options.rate === flock.rates.DEMAND), // At demand rate, override the rate of all ugens.
                visitors: that.ugens.add,
                buffers: that.enviro.buffers,
                buses: that.enviro.buses,
                audioSettings: that.enviro.audioSettings
            });
            
            // Add this synth to the tail of the synthesis environment if appropriate.
            if (that.options.addToEnvironment !== false) {
                that.enviro.tail(that);
            }
        };
        
        that.init();
        return that;
    };
    
    /**
     * Makes a new syth.
     * Deprecated. Use flock.synth instead. This is provided for semi-backwards-compatibility with
     * previous version of Flocking where flock.synth had a multi-argument signature.
     */
    flock.synth.make = function (def, options) {
        options = options || {};
        options.synthDef = def;
        return flock.synth(options);
    };
    
    
    fluid.defaults("flock.synth.ugenCache", {
        gradeNames: ["fluid.littleComponent", "autoInit"]
    });
    
    flock.synth.ugenCache.finalInit = function (that) {
        that.named = {};
        that.active = [];
        that.all = []; // TODO: Memory leak! Need to remove ugens from both all and active.
        
        that.add = function (ugens) {
            var i,
                ugen;
            
            ugens = fluid.makeArray(ugens);
            for (i = 0; i < ugens.length; i++) {
                ugen = ugens[i];
                that.all.push(ugen);
                if (ugen.gen) {
                    that.active.push(ugen);
                }
                if (ugen.id) {
                    that.named[ugen.id] = ugen;
                }
            }

        };
        
        that.remove = function (ugens, recursively) {
            var active = that.active,
                named = that.named,
                i,
                ugen,
                idx,
                inputs,
                input;
            
            ugens = fluid.makeArray(ugens);
            for (i = 0; i < ugens.length; i++) {
                ugen = ugens[i];
                idx = active.indexOf(ugen);
                if (idx > -1) {
                    active.splice(idx, 1);
                }
                if (ugen.id) {
                    delete named[ugen.id];
                }
                if (recursively) {
                    inputs = [];
                    for (input in ugen.inputs) {
                        inputs.push(ugen.inputs[input]);
                    }
                    that.remove(inputs, true);
                }
            }
        };
        
        that.reattachInputs = function (currentUGen, previousUGen, inputsToReattach) {
            var i,
                inputName;
                
            if (inputsToReattach) {
                // Replace only the specified inputs.
                for (i = 0; i < inputsToReattach.length; i++) {
                    inputName = inputsToReattach[i];
                    currentUGen.inputs[inputName]  = previousUGen.inputs[inputName];
                }
            } else {
                // Replace all the current ugen's inputs with the previous'.
                currentUGen.inputs = previousUGen.inputs;
            }
        };
        
        that.replaceActiveOutput = function (currentUGen, previousUGen) {
            // TODO: This only traverses active ugens, which is probably adequate for most real-world cases 
            // but still not comprehensive. This should be replaced with a graph walker.
            var i,
                ugen,
                inputName,
                input;
                
            for (i = 0; i < that.active.length; i++) {
                ugen = that.active[i];
                for (inputName in ugen.inputs) {
                    input = ugen.inputs[inputName];
                    if (input === previousUGen) {
                        ugen.inputs[inputName] = currentUGen;
                        break;
                    }
                }
            }
            
            return currentUGen;
        };
        
        /**
         * Swaps a list of unit generators with a new set, reattaching the specified inputs and replacing outputs.
         *
         * @param {UGen || Array of UGens} ugens the new unit generators to swap in
         * @param {UGen || Array of UGens} previousUGens the unit generators to replace
         * @param {Object || boolean} inputsToReattach a list of inputs to reattach to the new unit generator, or a boolean for all
         * @return the newly-connected unit generators
         */
        that.swap = function (ugens, previousUGens, inputsToReattach) {
            var i,
                prev,
                current;
                
            // Note: This algorithm assumes that number of previous and current ugens is the same length.
            previousUGens = fluid.makeArray(previousUGens);
            ugens = fluid.makeArray(ugens);
            
            for (i = 0; i < previousUGens.length; i++) {
                prev = previousUGens[i];
                current = ugens[i];
                that.reattachInputs(current, prev, inputsToReattach);
                that.replaceActiveOutput(current, prev);
            }
            
            return ugens;
        };
        
        /**
         * Replaces a list of unit generators with another.
         *
         * If "reattachInputs" is an array, it should contain a list of inputNames to replace.
         *
         * @param {UGen||Array of UGens} ugens the new unit generators to add
         * @param {UGen||Array of UGens} previousUGens the unit generators to replace with the new ones
         * @param {boolean||Object} reattachInputs specifies if the old unit generator's inputs should be attached to the new ones
         * @return the new unit generators
         */
        that.replace = function (ugens, previousUGens, reattachInputs) {
            if (reattachInputs) {
                reattachInputs = typeof (reattachInputs) === "object" ? reattachInputs : undefined;
                that.swap(ugens, previousUGens, reattachInputs);
            }
            that.remove(previousUGens, true);
            that.add(ugens);
            
            return ugens;
        };
        
        return that;
    };
    
    
    fluid.defaults("flock.synth.group", {
        gradeNames: ["flock.node", "flock.nodeList", "autoInit"],
        rate: flock.rates.AUDIO
    });
    
    flock.synth.group.finalInit = function (that) {
        that.rate = that.options.rate;
        that.enviro = that.enviro || flock.enviro.shared;
        
        flock.synth.group.makeDispatchedMethods(that, [
            "input", "get", "set", "gen", "play", "pause"
        ]);
        
        that.init = function () {
            if (that.options.addToEnvironment !== false) {
                that.enviro.tail(that);
            }    
        };
        
        that.init();
    };
    
    flock.synth.group.makeDispatcher = function (nodes, msg) {
        return function () {
            var i,
                node,
                val;
            for (i = 0; i < nodes.length; i++) {
                node = nodes[i];
                val = node[msg].apply(node, arguments);
            }
            
            return val;
        };
    };
    
    flock.synth.group.makeDispatchedMethods = function (that, methodNames) {
        var name,
            i;
            
        for (i = 0; i < methodNames.length; i++) {
            name = methodNames[i];
            that[name] = flock.synth.group.makeDispatcher(that.nodes, name, flock.synth.group.dispatch);
        }
        
        return that;
    };
    
    
    fluid.defaults("flock.synth.polyphonic", {
        gradeNames: ["flock.synth.group", "autoInit"],
        mergePolicy: {
            synthDef: "nomerge"
        },
        noteSpecs: {
            on: {
                "env.gate": 1
            },
            off: {
                "env.gate": 0
            }
        },
        maxVoices: 16,
        initVoicesLazily: true,
        amplitudeKey: "env.sustain",
        amplitudeNormalizer: "static" // "dynamic", "static", Function, falsey
    });
    
    flock.synth.polyphonic.finalInit = function (that) {
        that.activeVoices = {};
        that.freeVoices = [];
        
        that.noteChange = function (voice, eventName, changeSpec) {
            var noteEventSpec = that.options.noteSpecs[eventName];
            changeSpec = $.extend({}, noteEventSpec, changeSpec);
            voice.input(changeSpec);
        };
        
        that.noteOn = function (noteName, changeSpec) {
            var voice = that.nextFreeVoice();
            if (that.activeVoices[noteName]) {
                that.noteOff(noteName);
            }
            that.activeVoices[noteName] = voice;
            that.noteChange(voice, "on", changeSpec);
            
            return voice;
        };
        
        that.noteOff = function (noteName, changeSpec) {
            var voice = that.activeVoices[noteName];
            if (!voice) {
                return null;
            }
            that.noteChange(voice, "off", changeSpec);
            delete that.activeVoices[noteName];
            that.freeVoices.push(voice);
            
            return voice;
        };
        
        that.createVoice = function () {
            var voice = flock.synth({
                synthDef: that.options.synthDef,
                addToEnvironment: false
            });
            
            var normalizer = that.options.amplitudeNormalizer,
                ampKey = that.options.amplitudeKey,
                normValue;
                
            if (normalizer) {
                if (typeof(normalizer) === "function") {
                    norm(voice, ampKey);
                } else if (normalizer === "static") {
                    normValue = 1.0 / that.options.maxVoices;
                    voice.input(ampKey, normValue);
                }
                // TODO: Implement dynamic voice normalization.
            }
            that.nodes.push(voice);
            
            return voice;
        };
        
        that.pooledVoiceAllocator = function () {
            return that.freeVoices.pop();
        };
        
        that.lazyVoiceAllocator = function () {
            return that.freeVoices.length > 1 ?
                that.freeVoices.pop() : Object.keys(that.activeVoices).length > that.options.maxVoices ?
                null : that.createVoice();
        };
        
        that.init = function () {
            if (!that.options.initVoicesLazily) {
                for (var i = 0; i < that.options.maxVoices; i++) {
                    that.freeVoices[i] = that.createVoice();
                }
                that.nextFreeVoice = that.pooledVoiceAllocator;
            } else {
                that.nextFreeVoice = that.lazyVoiceAllocator;
            }
        };
        
        that.init();
        return that;
    };
    
    /**
     * Monkey patches fluid.isPrimitive until an general Infusion solution can be put in place for
     * defining custom primitive detection logic. Currently, ArrayBufferViews are detected as objects.
     */
    fluid.isPrimitive = function (value) {
        var valueType = typeof (value);
        return !value || valueType === "string" || valueType === "boolean" || valueType === "number" || 
            valueType === "function" || value instanceof Float32Array;
    };
    
}());
