/*
 * Copyright (c) 2011 Vinay Pulim <vinay@milewise.com>
 * MIT Licensed
 */

function findKey(obj, val) {
    for (var n in obj) if (obj[n] === val) return n;
}

var url = require('url'),
    compress = null;

try { compress = require("compress"); } catch(e) {}

function each(o, f) {
  Object.keys(o).forEach(function(k) {
    f(k, o[k], o);
  });
}

var Server = function(server, path, services, wsdl) {
    this.services = services;
    this.wsdl = wsdl;

    if (!server) {
      return;
    }
    var self = this,
        listeners = server.listeners('request');

    if (path[path.length-1] != '/') path += '/';
    wsdl.onReady(function(err) {
        server.removeAllListeners('request');
        server.addListener('request', function(req, res) {
            if (typeof self.authorizeConnection === 'function') {
              if (!self.authorizeConnection(req)) {
                res.statusCode = 403;
                res.end();
                return;
              }
            }
            var reqPath = url.parse(req.url).pathname;
            if (reqPath[reqPath.length-1] != '/') reqPath += '/';
            if (path === reqPath) {
                self._requestListener(req, res);
            }
            else {
                for (var i = 0, len = listeners.length; i < len; i++){
                  listeners[i].call(this, req, res);
                }
            }
        });
    })
}

Server.prototype._requestListener = function(req, res) {
    var self = this;
    if (req.method === 'GET' || req.method === 'HEAD') {
        var search = url.parse(req.url).search;
        if (search && search.toLowerCase() === '?wsdl') {
            res.setHeader("Content-Type", "application/xml");
            if (req.method === 'GET') {
                res.write(self.wsdl.toXML());
            }
        }
        res.end();
    }
    else if (req.method === 'POST') {
        res.setHeader('Content-Type', req.headers['content-type']);
        var chunks = [], gunzip;
        if (compress && req.headers["content-encoding"] == "gzip") {
            gunzip = new compress.Gunzip;
            gunzip.init();
        }
        req.on('data', function(chunk) {
            if (gunzip) chunk = gunzip.inflate(chunk, "binary");
            chunks.push(chunk);
        });
        req.on('end', function() {
            var xml = chunks.join(''), result;
            if (gunzip) {
                gunzip.end();
                gunzip = null
            }
            try {
                self._process(xml, req.url, function(result) {
                    res.write(result);
                    res.end();
                    if (typeof self.log === 'function') {
                      self.log("received", xml);
                      self.log("replied", result);
                    }
                });
            }
            catch(err) {
                err = err.stack || err;
                res.write(err);
                res.end();
                if (typeof self.log === 'function') {
                  self.log("error", err);
                }
            }
        });
    }
    else {
        res.end();
    }
};

Server.prototype._process = function(input, URL, callback) {
    var self = this,
        pathname = url.parse(URL).pathname.replace(/\/$/,''),
        obj = this.wsdl.xmlToObject(input),
        body = obj.Body,
        bindings = this.wsdl.definitions.bindings, binding,
        methods, method, methodName,
        serviceName, portName;

    if (typeof self.authenticate === 'function') {
      if (obj.Header == null || obj.Header.Security == null) {
        throw new Error('No security header');
      }
      if (!self.authenticate(obj.Header.Security)) {
        throw new Error('Invalid username or password');
      }
    }

    if (!self.bindingMap) {
      console.log("Building binding map on demand for", pathname);
      // Build the binding map on demand....
      var bindingMap = self.bindingMap = {};
      each(self.wsdl.definitions.services, function(serviceName, service) {
        each(service.ports, function(portName, port) {
          var b = bindingMap[url.parse(port.location).pathname.replace(/\/$/, '')] = port.binding;
          b.serviceName = serviceName;
          b.portName = portName;
        });
      });
    }

    console.log("Using binding map", self.bindingMap);

    binding = self.bindingMap[pathname];

    // use port.location and current url to find the right binding
    //binding = (function(self){
    //    var services = self.wsdl.definitions.services;
    //    for(serviceName in services ) {
    //        var service = services[serviceName];
    //        var ports = service.ports;
    //        for(portName in ports) {
    //            var port = ports[portName];
    //            var portPathname = url.parse(port.location).pathname.replace(/\/$/,'');
    //            if(portPathname===pathname)
    //                return port.binding;
    //        }
    //    }
    //})(this);

    methods = binding.methods;

        if(binding.style === 'rpc') {
            methodName = Object.keys(body)[0];
            self._executeMethod({
                serviceName: binding.serviceName,
                portName: binding.portName,
                methodName: methodName,
                outputName: methodName + 'Response',
                args: body[methodName],
                style: 'rpc'
            }, callback);
        } else {
            var messageElemName = Object.keys(body)[0];
            var pair = binding.topElements[messageElemName];
            self._executeMethod({
                serviceName: binding.serviceName,
                portName: binding.portName,
                methodName: pair.methodName,
                outputName: pair.outputName,
                args: body[messageElemName],
                style: 'document'
            }, callback);
        }
}

Server.prototype._executeMethod = function(options, callback) {
    options = options || {};
    var self = this,
        method, body,
        serviceName = options.serviceName,
        portName = options.portName,
        methodName = options.methodName,
        outputName = options.outputName,
        args = options.args,
        style = options.style,
        handled = false;
    console.log("Execute method", options);
    try {
        method = this.services[serviceName][portName][methodName];
    } catch(e) {
        return callback(this._envelope(''));
    }

    function handleResult(result) {
        if (handled) return;
        handled = true;

        var xmlns = self.wsdl.newXMLNS();
        if(style==='rpc') {
            body = self.wsdl.objectToRpcXML(outputName, result, '', self.wsdl.definitions.$targetNamespace);
        } else {
            var element = self.wsdl.definitions.services[serviceName].ports[portName].binding.methods[methodName].output;
            //console.log("Schemas", require("util").inspect(self.wsdl.definitions.schemas, true, 10, true));
            console.log("Output", require("util").inspect(element, true, 10, true));
            body = self.wsdl.objectToDocumentXML(outputName, result, element, xmlns);
        }
        callback(self._envelope(body, xmlns));
    }

    var result = method(args, handleResult);
    if (typeof result !== 'undefined') {
        handleResult(result);
    }
}

Server.prototype._envelope = function(body, xmlns) {
    var defs = this.wsdl.definitions,
        ns = defs.$targetNamespace,
        encoding = '',
        alias = findKey(defs.xmlns, ns),
        xmlnsAttr = xmlns ? xmlns.toAttribute() : this.wsdl.xmlnsInEnvelope;
    var xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
               encoding +
               xmlnsAttr + '>' +
                "<soap:Body>" +
                    body +
                "</soap:Body>" +
            "</soap:Envelope>";
    return xml;
}

exports.Server = Server;
