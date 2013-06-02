module.exports = function (middleware, options, callback) {

    return function (req, res, next) {
        res.set({
            'Access-Control-Allow-Origin': options.accessControl.allowOrigin,
            'Access-Control-Allow-Methods': options.accessControl.allowMethods
        });
        var UploadHandler = require('./uploadhandler')(options);
        var handler = new UploadHandler(req, res, callback || function (result, files, redirect) {
            var data = { files: result };
            if (redirect) {
                res.redirect(redirect.replace(/%s/, encodeURIComponent(JSON.stringify(data))));
            } else {
                res.set({
                    'Content-Type': (req.headers.accept || '').indexOf('application/json') !== -1
                        ? 'application/json'
                        : 'text/plain'
                });
                if (req.method == 'HEAD') return res.send(200);
                res.json(200, data);
            }
        });

        handler.on('begin', function (fileInfo) {
            middleware.emit('begin', fileInfo);
        });
        handler.on('end', function (fileInfo) {
            middleware.emit('end', fileInfo);
        });
        handler.on('abort', function (fileInfo) {
            middleware.emit('abort', fileInfo);
        });
        handler.on('error', function (e) {
            middleware.emit('abort', e);
        });
        handler.on('delete', function (fileName) {
            middleware.emit('delete', fileName);
        });
        handler.on('file', function (fileInfo) {
            middleware.emit('file', fileInfo);
        });
        handler.on('image', function (fileInfo) {
            middleware.emit('image', fileInfo);
        });
        handler.on('processed', function (fileInfo, files) {
            middleware.emit('processed', fileInfo, files);
        });

        switch (req.method) {
            case 'OPTIONS':
                res.end();
                break;
            case 'HEAD':
            case 'GET':
                handler.get();
                break;
            case 'POST':
                handler.post();
                break;
            case 'DELETE':
                handler.destroy();
                break;
            default:
                res.send(405);
        }
    }
};
