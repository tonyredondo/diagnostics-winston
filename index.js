'use strict';
const os = require('os');
const Transport = require('winston-transport');
const http = require('http');
const zlib = require('zlib');

module.exports = class DiagnosticsTransport extends Transport {
    constructor (options = {}) {
        super(options);

        if (!options.endpoint) {
            throw new Error('Missing required option: `endpoint`');
        }
        if (!options.environment) {
            throw new Error('Missing required option: `environment`');
        }

        this.name = options.name || 'diagnostics';
        this.endpoint = options.endpoint;
        this.environment = options.environment;

        this.flushInterval = options.flushInterval || 5000;
        this.bufferSize = options.bufferSize || 5000;

        this.assemblyField = options.assemblyField || ['assembly', 'assemblyName'];
        this.typeField = options.typeField || ['type', 'typeName'];
        this.codeField = options.codeField || ['code'];
        this.groupField = options.groupField || ['group', 'groupName'];
        this.messageField = options.messageField || ['message', 'msg'];
        this.exceptionField = options.exceptionField || ['exception'];
        this.metadataField = options.metadataField || ['metadata'];
        this.traceNameField = options.traceNameField || ['traceName', 'name'];
        this.traceDataField = options.traceDataField || ['traceData', 'data'];
        this.tagsField = options.tagsField || ['traceTags', 'tags'];

        this.groupFieldFunction = options.groupFieldFunction || null;

        this.machine = options.machine || os.hostname();
        this.application = options.application || null;
        this.processName = options.processName || process.title;

        this.http_options = {
            hostname: options.endpoint,
            port: options.port || '80',
            path: '/api/diagnostics/ingest',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip'
            }
        }

        this.itemBuffer = [];
        this.flushTimer = setInterval(this.flushBuffers, this.flushInterval, this);
    }

    async flushBuffers(self) {
        if (self.itemBuffer.length > 0) {
            const payload = self.itemBuffer.splice(0, self.itemBuffer.length);
            var jsonPayload = JSON.stringify(payload, null, 2);
            zlib.gzip(jsonPayload, function (err, buffer) {
                var req = http.request(self.http_options, function(res) {});
                req.on('error', function(e) {
                    console.log('Error: ' + e.message);
                });
                req.write(buffer);
                req.end();
            });
        }
    }

    async log(info, callback) {
        var tzoffset = (new Date()).getTimezoneOffset() * 60000; //offset in milliseconds
        const timestamp = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -1);
        var data = null;
        if (arguments.length == 4) {
            data = Object.assign({}, arguments[2]);
            data.level = arguments[0];
            data.message = arguments[1];
            callback = arguments[3];
        } else {
            data = Object.assign({}, info);
        }
        setImmediate(() => {
          this.emit.apply(this, arguments);
        });

        var item = {};
        item.timestamp = timestamp;
        item.environmentName = this.getValueOrDefault(data, 'environment', this.environment);
        item.machineName = this.getValueOrDefault(data, 'machine', this.machine);
        item.applicationName = this.getValueOrDefault(data, 'application', this.application);
        item.processName = this.getValueOrDefault(data, 'processName', this.processName);
        item.assemblyName = this.getFieldValue(data, this.assemblyField);
        item.typeName = this.getFieldValue(data, this.typeField);
        item.level = this.getValueOrDefault(data, 'level', 'Info');
        item.code = this.getFieldValue(data, this.codeField);
        item.message = this.getFieldValue(data, this.messageField);
        item.groupName = this.getFieldValue(data, this.groupField);
        item.exception = this.getFieldValue(data, this.exceptionField);
        item.metadata = this.getFieldValue(data, this.metadataField);
        item.traceName = this.getFieldValue(data, this.traceNameField);
        item.traceData = this.getFieldValue(data, this.traceDataField);
        item.traceTags = this.getFieldValue(data, this.tagsField);

        //Error, Warning, InfoBasic, InfoMedium, InfoDetail, Debug, Verbose, Stats, LibDebug, LibVerbose
        switch(item.level) {
            case 'silly':
                item.level = 'InfoDetail';
                break;
            case 'debug':
                item.level = 'Debug';
                break;
            case 'verbose':
                item.level = 'Verbose';
                break;
            case 'info':
                item.level = 'InfoBasic';
                break;
            case 'warn':
                item.level = 'Warning';
                break;
            case 'error':
                item.level = 'Error';
                break;
        }

        var duration = this.getValueOrDefault(data, 'durationMs', null);
        if (duration != null) {
            if (!item.traceTags) {
                item.traceTags = [];
            }
            item.traceTags.push({ key: 'duration', value: duration+'' });
        }

        if (item.exception instanceof Error) {
            const err = item.exception;
            item.exception = {
                exceptionType: null,
                message: err.message || null,
                source: err.code || null,
                stackTrace: err.stack || null
            };         
        }

        var stack = this.getValueOrDefault(data, 'stack', null);
        if (stack != null) {
            var message = 'Error: An exception has been thrown.';
            try {
                var fLineIdx = stack.indexOf('\n');
                message = stack.substring(0, fLineIdx);
                stack = stack.substring(fLineIdx + 2);    
            } catch {
            }
            if (!item.exception) {
                item.exception = {
                    exceptionType: null,
                    message: message,
                    source: this.code || null,
                    stackTrace: stack
                };
            }
        }

        if (!item.traceData && Object.keys(data).length > 0) {
            item.traceData = JSON.stringify(data);
        }

        if (!item.groupName && this.groupFieldFunction)
            item.groupName = this.groupFieldFunction(); 
        
        if (item.traceData && !item.traceName)
            item.traceName = item.message;

        this.appendToBuffer(item);
        if (typeof callback === "function")
            callback();
    }

    getValueOrDefault(item, key, defaultValue) {
        var value = item[key];
        if (value !== undefined) {
            delete item[key];
            return value;
        }
        return defaultValue;
    }
    getFieldValue(item, array) {
        for(var i = 0; i < array.length; i++) {
            var key = array[i];
            var value = item[key];
            if (value !== undefined) {
                delete item[key];
                return value;
            }
        }
        return null;
    }
    appendToBuffer(item) {
        if (this.itemBuffer.length >= this.bufferSize)
            this.itemBuffer.pop();
        this.itemBuffer.push(item);
    }
}