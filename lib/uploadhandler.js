var EventEmitter = require('events').EventEmitter,
    path = require('path'),
    fs = require('fs'),
    formidable = require('formidable'),
    imageMagick = require('imagemagick'),
    mkdirp = require('mkdirp'),
    async = require('async'),
    _ = require('lodash');
    
var convertArgs = [
    'srcPath', 'srcData', 'srcFormat',
    'dstPath', 'quality', 'format',
    'progressive', 'colorspace',
    'width', 'height',
    'strip', 'filter',
    'sharpening', 'customArgs',
    'timeout', 'gravity'
];

module.exports = function (options) {

    var FileInfo = require('./fileinfo')(
        _.extend({
            baseDir: options.uploadDir
        }, _.pick(options, 'minFileSize', 'maxFileSize', 'acceptFileTypes'))
    );

    var UploadHandler = function (req, res, callback) {
        EventEmitter.call(this);
        this.req = req;
        this.res = res;
        this.callback = callback;
    };
    require('util').inherits(UploadHandler, EventEmitter);

    UploadHandler.prototype.noCache = function () {
        this.res.set({
            'Pragma': 'no-cache',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Content-Disposition': 'inline; filename="files.json"'
        });
    };

    UploadHandler.prototype.get = function () {
        this.noCache();
        var files = [];
        fs.readdir(options.uploadDir(), _.bind(function (err, list) {
            _.each(list, function (name) {
                if (name.indexOf('.') != 0) {
                    var stats = fs.statSync(options.uploadDir() + '/' + name),
                        fileInfo;
                    if (stats.isFile()) {
                        fileInfo = new FileInfo({
                            name: name,
                            size: stats.size
                        });
                        this.initUrls(fileInfo);
                        files.push(fileInfo);
                    }
                }
            }, this);
            this.callback(files);
        }, this));
    };

    UploadHandler.prototype.post = function () {
        
        var self = this,
            form = new formidable.IncomingForm(),
            tmpFiles = [],
            files = [],
            map = {},
            redirect,
            counter = 1,
            finish = function() {
                if (!--counter) {
                    var data = [];
                    _.each(files, function (fileInfo) {
                        this.initUrls(fileInfo, true);
                        this.emit('end', fileInfo);
                        data.push(fileInfo.toResponse());
                    }, this);
                    this.callback(data, files, redirect);
                }
            }.bind(this);

        this.noCache();

        form.uploadDir = options.tmpDir;
        form
            .on('fileBegin', function (name, file) {
                tmpFiles.push(file.path);
                var fileInfo = new FileInfo(file);
                fileInfo.safeName();
                map[path.basename(file.path)] = fileInfo;
                files.push(fileInfo);
                self.emit('begin', fileInfo);
            })
            .on('field', function (name, value) {
                if (name === 'redirect') {
                    redirect = value;
                }
            })
            .on('file', function (name, file) {
                var mapKey = path.basename(file.path);
                var fileInfo = map[mapKey];
                if (fs.existsSync(file.path)) {
                    fileInfo.size = file.size;
                    if (!fileInfo.validate()) {
                        fs.unlink(file.path);
                        return;
                    } else {
                        counter++;
                    }
                    
                    var handledFile = function(err, fileInfo, processedFiles) {
                        fileInfo.processedFiles = processedFiles || [];
                        finish();
                    }

                    if (!fs.existsSync(options.uploadDir() + '/')) mkdirp.sync(options.uploadDir() + '/');
                    
                    fs.rename(file.path, options.uploadDir() + '/' + fileInfo.name, function (err) {
                        if (!err) {
                            self.processFile(fileInfo, handledFile);
                        } else {
                            var is = fs.createReadStream(file.path);
                            var os = fs.createWriteStream(options.uploadDir() + '/' + fileInfo.name);
                            is.on('end', function (err) {
                                if (!err) {
                                    fs.unlinkSync(file.path);
                                    return self.processFile(fileInfo, handledFile);
                                }
                                handledFile(fileInfo, []);
                            });
                            is.pipe(os);
                        }
                    });
                }
            })
            .on('aborted', function () {
                _.each(tmpFiles, function (file) {
                    var fileInfo = map[path.basename(file)];
                    self.emit('abort', fileInfo);
                    fs.unlink(file);
                });
            })
            .on('error', function (e) {
                self.emit('error', e);
            })
            .on('progress', function (bytesReceived, bytesExpected) {
                if (bytesReceived > options.maxPostSize) {
                    self.req.pause();
                }
            })
            .on('end', finish)
            .parse(self.req);
    };

    UploadHandler.prototype.destroy = function () {
        var self = this, url = path.join(this.req.app.path() || '/', this.req.url);
        var uploadUrl = options.uploadUrl();
        if (url.slice(0, uploadUrl.length) === uploadUrl) {
            var fileName = path.basename(decodeURIComponent(this.req.url));
            if (fileName.indexOf('.') != 0) {
                fs.unlink(options.uploadDir() + '/' + fileName, function (ex) {
                    _.each(options.imageVersions, function (value, version) {
                        fs.unlink(options.uploadDir() + '/' + version + '/' + fileName);
                    });
                    self.emit('delete', fileName);
                    self.callback(!ex);
                });
            }
        } else {
            self.callback(false);
        }
    };

    UploadHandler.prototype.initUrls = function (fileInfo, noCheck) {
        var baseUrl = (options.ssl ? 'https:' : 'http:') + '//' + (options.hostname || this.req.get('Host'));
        fileInfo.setUrl(null, baseUrl + options.uploadUrl());
        fileInfo.setUrl('delete', baseUrl + this.req.originalUrl);
        _.each(options.imageVersions, function (value, version) {
            if (noCheck || fs.existsSync(options.uploadDir() + '/' + version + '/' + fileInfo.name)) {
                fileInfo.setUrl(version, baseUrl + options.uploadUrl() + '/' + version);
            }
        }, this);
    };
    
    UploadHandler.prototype.processFile = function(fileInfo, processOpts, callback) {
        if (_.isFunction(processOpts)) {
            callback = processOpts;
            processOpts = _.extend({}, options); // use global options
        }
        var self = this;
        var files = [];
        var uploadDir = _.result(processOpts, 'uploadDir');
        var srcPath = uploadDir + '/' + fileInfo.name;
        var isImage = processOpts.imageTypes && processOpts.imageTypes.test(fileInfo.name);
        var commands = [];
        fileInfo.metadata = {};
        
        // File metadata
        if (processOpts.identify) {
            if (isImage) {
                commands.push(function(next) {
                    imageMagick.identify(srcPath, function(err, features) {
                        fileInfo.metadata = err ? {} : features;
                        fileInfo.metadata.fromOriginal = true;
                        next();
                    });
                });
            } // could add generic file identify fn here
        }
        
        // Generic processing, after images have been processed
        _.each([].concat(processOpts.process || []), function(cmd) {
            commands.push(function(next) {
                cmd.call(null, fileInfo, srcPath, function(err, result) {
                    var info = _.extend({}, fileInfo, { srcPath: srcPath, result: result });
                    if (err && !info.error) info.error = err;
                    if (_.isObject(result) && result instanceof FileInfo) {
                        files.push(result);
                    }
                    next(info.error);
                });
            });
        });
        
        // Image processing
        if (isImage) {
            commands.push(function(next) {
                async.mapSeries(_.keys(processOpts.imageVersions || {}), function (version, done) {
                    var identify = processOpts.identify;
                    var dstPath = uploadDir + '/' + version + '/' + fileInfo.name;
                    var cb = function(err) {
                        var args = arguments;
                        var info = _.extend({}, fileInfo, { 
                            srcPath: srcPath, dstPath: dstPath, version: version
                        });
                        if (err) info.error = err;
                        if (!err && identify) {
                            imageMagick.identify(dstPath, function(err, features) {
                                info.metadata = err ? {} : features;
                                info.metadata.fromOriginal = false;
                                files.push(info);
                                done.apply(null, args); 
                            });
                        } else {
                            files.push(info);
                            done.apply(null, args); 
                        }
                    };
                    
                    var process = function(err) {
                        if (err) return cb(err);
                        var opts = processOpts.imageVersions[version] || {};
                        if (_.isObject(fileInfo.error)) {
                            cb(fileInfo.error);
                        } else if (_.isFunction(opts)) {
                            opts.call(imageMagick, fileInfo, srcPath, dstPath, cb);
                        } else if (_.isArray(opts)) { // raw imagemagick convert
                            imageMagick.convert(opts, cb);
                        } else if (_.isObject(opts)) {
                            identify = (identify || opts.identify) && opts.identify !== false;
                            var m = opts.crop ? 'crop' : 'resize';
                            var args = _.pick(opts, convertArgs);
                            args.srcPath = args.srcPath || srcPath;
                            args.dstPath = args.dstPath || dstPath;
                            args.customArgs = args.customArgs || opts.imageArgs || ['-auto-orient'];
                            imageMagick[m](args, cb);
                        } else {
                            cb(new Error('Invalid image version config: ' + version));
                        }
                    }
                    
                    var versionDir = uploadDir + '/' + version + '/';
                    fs.exists(versionDir, function(exists) {
                        exists ? process() : mkdirp(versionDir, process);
                    }); 
                }, next);
            });
        }
        
        async.series(commands, function(err) {
            if (!err) self.emit('processed', fileInfo, files);
            callback(err, fileInfo, files);
        });
    };

    return UploadHandler;
}

