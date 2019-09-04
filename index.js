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
        this.ignoreField = options.ignoreField || [];

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

    flushBuffers(self) {
        if (self.itemBuffer.length > 0) {
            const payload = self.itemBuffer.splice(0, self.itemBuffer.length);
            var jsonPayload = JSON.stringify(payload, null, 2);
            zlib.gzip(jsonPayload, function (err, buffer) {
                var req = http.request(self.http_options, function(res) {});
                req.on('error', function(e) {
                    console.log('Error sending data to diagnostics: ' + e.message);
                });
                req.write(buffer);
                req.end();
            });
        }
    }

    logException(msg, info, next, err) {
      var tzoffset = (new Date()).getTimezoneOffset() * 60000; //offset in milliseconds
      const timestamp = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -1);
      var item = {
        timestamp: timestamp,
        environmentName: this.environment,
        machineName: this.machine,
        applicationName: this.application,
        processName: this.processName,
        groupName: this.getFieldValue(info, this.groupField),
        level: 'Error',
        message: msg,
      };

      if (err instanceof Error) {
        item.exception = {
            exceptionType: 'error',
            message: err.message || null,
            source: err.code || null,
            stackTrace: err.stack || null,
            data: []
        };
        if (err.stack) {
          try {
            var fLineIdx = err.stack.indexOf('\n');
            var typeIdx = err.stack.indexOf(':');
            if (typeIdx < fLineIdx) {
              item.exception.exceptionType = err.stack.substring(0, typeIdx);
            }
            item.exception.stackTrace = err.stack.substring(fLineIdx + 1);
          } catch (e) {
              console.log(e);
          }
        }
        if (info && info.process) {
          item.exception.data.push({ key: 'cwd', value: info.process.cwd });
          item.exception.data.push({ key: 'execPath', value: info.process.execPath });
          item.exception.data.push({ key: 'version', value: info.process.version });
          item.exception.data.push({ key: 'argv', value: JSON.stringify(info.process.argv) });
          if (info.process.memoryUsage) {
            item.exception.data.push({ key: 'mem.rss', value: JSON.stringify(info.process.memoryUsage.rss) });
            item.exception.data.push({ key: 'mem.heapTotal', value: JSON.stringify(info.process.memoryUsage.heapTotal) });
            item.exception.data.push({ key: 'mem.heapUsed', value: JSON.stringify(info.process.memoryUsage.heapUsed) });
          }
        }
      }

      if (!item.groupName && this.groupFieldFunction)
      item.groupName = this.groupFieldFunction(item);

      this.appendToBuffer(item);
      this.flushBuffers(this);
      if (next)
        next();
    }

    log(info, callback) {
        var tzoffset = (new Date()).getTimezoneOffset() * 60000; //offset in milliseconds
        const timestamp = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -1);
        var data = null;
        if (arguments.length == 4) {
            if (arguments[2] instanceof Error) {
              data = {}
              data.exception = arguments[2];
            } else {
              data = Object.assign({}, arguments[2]);
            }
            data.level = arguments[0];
            data.message = arguments[1];
            callback = arguments[3];
        } else {
            data = Object.assign({}, info);
        }
        setImmediate(() => {
          try {
            this.emit.apply(this, arguments);
          } catch(e) {
          }
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
        item.metadata = this.getObjectAsKeyValueArray(this.getAllFieldValue(data, this.metadataField));
        item.traceName = this.getFieldValue(data, this.traceNameField);
        item.traceData = this.getFieldValue(data, this.traceDataField);
        item.traceTags = this.getObjectAsKeyValueArray(this.getAllFieldValue(data, this.tagsField)) || [];
        this.removeFieldValue(data, this.ignoreField);

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
            item.traceTags.push({ key: 'duration', value: duration + ' ms' });
        }

        //Format detector
        if (item.message) {
          var msg = item.message.trim();
          if (msg.length > 0) {
            var prefix = "";
            if (msg[0] == '{' || msg[0] == '[') {
              prefix = "[OBJECT]";
              item.message = "";
              item.traceData = msg;
            } else {
              var regex = /<[^>]+>/gm, matches, firstIndex = null, tagCount = 0;
              while (matches = regex.exec(msg)) {
                if (firstIndex === null) {
                  firstIndex = matches.index;
                }
                tagCount++;
                if (tagCount >= 2)
                  break;
              }
              if (tagCount >= 2) {
                prefix = "[OBJECT]";
                item.traceData = msg.substring(firstIndex);
                item.message = msg.substring(0, firstIndex - 1);
              }
            }
            if (item.message.trim().length == 0 && prefix) {
              if (item.traceData.length > 100) {
                item.message = prefix +" -> " + item.traceData.substring(0, 100) + "...";
              } else {
                item.message = prefix + " -> " + item.traceData;
              }
            }
          }
        }

        if (item.exception instanceof Error) {
            const err = item.exception;
            item.exception = {
                exceptionType: null,
                message: err.message || null,
                source: err.code || null,
                stackTrace: err.stack || null,
                data: []
            };
            if (!item.message) {
              item.message = item.exception.message;
            }
            if (err.stack) {
              try {
                var fLineIdx = err.stack.indexOf('\n');
                var typeIdx = err.stack.indexOf(':');
                if (typeIdx < fLineIdx) {
                  item.exception.exceptionType = err.stack.substring(0, typeIdx);
                }
                item.exception.stackTrace = err.stack.substring(fLineIdx + 1);
              } catch (e) {
                  console.log(e);
              }
            }
            item.exception.data.push({ key: 'cwd', value: process.cwd() });
            item.exception.data.push({ key: 'execPath', value: process.execPath });
            item.exception.data.push({ key: 'version', value: process.version });
            item.exception.data.push({ key: 'argv', value: JSON.stringify(process.argv) });
            var memoryUsage = process.memoryUsage();
            if (memoryUsage) {
              item.exception.data.push({ key: 'mem.rss', value: memoryUsage.rss });
              item.exception.data.push({ key: 'mem.heapTotal', value: memoryUsage.heapTotal });
              item.exception.data.push({ key: 'mem.heapUsed', value: memoryUsage.heapUsed });
            }
        }

        var stack = this.getValueOrDefault(data, 'stack', null);
        if (stack != null) {
            var message = 'Error: An exception has been thrown.';
            try {
                var fLineIdx = stack.indexOf('\n');
                message = stack.substring(0, fLineIdx);
                stack = stack.substring(fLineIdx + 1);
            } catch (e) {
                console.log(e);
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

        if (typeof item.traceData === 'string') {
          if (Object.keys(data).length > 0) {
            var nTags = this.getObjectAsKeyValueArray(data);
            for(var i = 0; i < nTags.length; i++)
              item.traceTags.push(nTags[i]);
          }
        } else if (item.traceData) {
            item.traceData = JSON.stringify(item.traceData);
        } else if (Object.keys(data).length > 0) {
            item.traceData = JSON.stringify(data);
        }

        if (!item.groupName && this.groupFieldFunction)
            item.groupName = this.groupFieldFunction(item);

        if (item.traceData && !item.message)
          item.message = "[OBJECT]";

        if (item.traceData && !item.traceName)
            item.traceName = item.message;

        this.appendToBuffer(item);
        if (item.level === 'Error') {
            this.flushBuffers(this);
        }
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
    getAllFieldValue(item, array) {
      var nItem = {}
      for(var i = 0; i < array.length; i++) {
          var key = array[i];
          var value = item[key];
          if (value !== undefined) {
            delete item[key];
            nItem[key] = value;
          }
      }
      return nItem;
    }
    getObjectAsKeyValueArray(item) {
      if (Array.isArray(item)) {
        return item;
      }
      var res = [];
      if (item) {
        var keys = Object.keys(item);
        for(var i = 0; i < keys.length; i++) {
          var key = keys[i];
          var value = item[key];
          if (Array.isArray(value)) {
            var shouldContinue = false;
            for(var j = 0; j < value.length; j++) {
              var innerValue = value[j];
              if (innerValue["key"] && innerValue["value"]) {
                res.push(innerValue);
                shouldContinue = true;
              }
            }
            if (shouldContinue)
              continue;
          }
          if (typeof value !== 'string') {
            value = JSON.stringify(value);
          }
          res.push({ key: key, value: value });
        }
      }
      return res;
    }
    removeFieldValue(item, array) {
      for(var i = 0; i < array.length; i++) {
          var key = array[i];
          var value = item[key];
          if (value !== undefined) {
              delete item[key];
          }
      }
  }
    appendToBuffer(item) {
        if (this.itemBuffer.length >= this.bufferSize)
            this.itemBuffer.pop();
        this.itemBuffer.push(item);
    }
}
