/*
 * Copyright (c) 2011 Vinay Pulim <vinay@milewise.com>
 * MIT Licensed
 */

var expat = require('node-expat'),
    inherits = require('util').inherits,
    http = require('./http'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    assert = require('assert').ok;

var Primitives = exports.Primitives = {
    string: 1, boolean: 1, decimal: 1, float: 1, double: 1,
    anyType: 1, byte: 1, int: 1, long: 1, short: 1,
    unsignedByte: 1, unsignedInt: 1, unsignedLong: 1, unsignedShort: 1,
    duration: 0, dateTime: 0, time: 0, date: 0,
    gYearMonth: 0, gYear: 0, gMonthDay: 0, gDay: 0, gMonth: 0,
    hexBinary: 0, base64Binary: 0, anyURI: 0, QName: 0, NOTATION: 0
};

function splitNSName(nsName) {
    var i = (nsName != null) ? nsName.indexOf(':') : -1;
    return i < 0 ? {namespace:null,name:nsName} : {namespace:nsName.substring(0, i), name:nsName.substring(i+1)};
}

function xmlEscape(obj) {
    if (typeof(obj) === 'string') {
        return obj
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
    }

    return obj;
}

var trimLeft = /^[\s\xA0]+/;
var trimRight = /[\s\xA0]+$/;

function trim(text) {
    return text.replace(trimLeft, '').replace(trimRight, '');
}

function extend(base, obj) {
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            base[key] = obj[key];
        }
    }
    return base;
}

function findKey(obj, val) {
    for (var n in obj) if (obj[n] === val) return n;
}

var Element = function(nsName, attrs) {
    var parts = splitNSName(nsName);

    this.nsName = nsName;
    this.namespace = parts.namespace;
    this.name = parts.name;
    this.children = [];
    this.xmlns = {};
    for (var key in attrs) {
        var match = /^xmlns:?(.*)$/.exec(key);
        if (match) {
            this.xmlns[match[1]] = attrs[key];
        }
        else {
            this['$'+key] = attrs[key];
        }
    }
}
Element.prototype.deleteFixedAttrs = function() {
    this.children && this.children.length === 0 && delete this.children;
    this.xmlns && Object.keys(this.xmlns).length === 0 && delete this.xmlns;
    delete this.nsName;
    delete this.namespace;
    delete this.name;
}
Element.prototype.allowedChildren = [];
Element.prototype.startElement= function(stack, nsName, attrs) {
    if (!this.allowedChildren) return;

    var childClass = this.allowedChildren[splitNSName(nsName).name],
        element = null;

    if (childClass) {
        stack.push(new childClass(nsName, attrs));
    }
    else {
        this.unexpected(nsName);
    }

}
Element.prototype.endElement = function(stack, nsName) {
    if (this.nsName === nsName) {
        if(stack.length < 2 ) return;
        var parent = stack[stack.length - 2];
        if (this !== stack[0]) {
            extend(stack[0].xmlns, this.xmlns);
            // delete this.xmlns;
            parent.children.push(this);
            parent.addChild(this);
        }
        stack.pop();
    }
}
Element.prototype.addChild = function(child) { return; }
Element.prototype.unexpected = function(name) {
    throw new Error('Found unexpected element (' + name + ') inside ' + this.nsName);
}
Element.prototype.description = function(definitions) {
    return this.$name || this.name;
}
Element.prototype.init = function() {};
Element.createSubClass = function() {
    var root = this;
    var subElement = function() {
        root.apply(this, arguments);
        this.init();
    };
    // inherits(subElement, root);
    subElement.prototype.__proto__ = root.prototype;
    return subElement;
}

exports.Element = Element;

function mapElementTypes(elementTypeMap, typeString) {
  var rtn = {};
  if (typeString) {
    var types = typeString.split(' ');
    types.forEach(function(type){
        rtn[type.replace(/^_/,'')] = (elementTypeMap[type] || [Element]) [0];
    });
  }
  return rtn;
}

exports.mapElementTypes = mapElementTypes;

function each(o, f) {
  Object.keys(o).forEach(function(k) {
    f(k, o[k], o);
  });
}

var XMLNS = exports.XMLNS = function(map, defaulter) {
  var p2u = this.prefixToUri = {},
      u2p = this.uriToPrefix = {};
  if (map) {
    each(map, function(prefix, uri) {
      p2u[prefix] = uri;
      u2p[uri] = prefix;
    });
  }
  this.nextGen = 1;
  this.used = {};
  this.defaulter = defaulter;
};

XMLNS.prototype.add = function(pfx, uri) {
  this.prefixToUri[pfx] = uri;
  this.uriToPrefix[uri] = pfx;
};

XMLNS.prototype.getUri = function(pfx) {
  return this.prefixToUri[pfx];
};

XMLNS.prototype.toAttribute = function() {
  var parts = [];
  each(this.used, function(pfx, uri) {
    if (pfx === '') return;
    switch (uri) {
        case "http://xml.apache.org/xml-soap" : // apachesoap
        case "http://schemas.xmlsoap.org/wsdl/" : // wsdl
        case "http://schemas.xmlsoap.org/wsdl/soap/" : // wsdlsoap
        case "http://schemas.xmlsoap.org/soap/encoding/" : // soapenc
        case "http://www.w3.org/2001/XMLSchema" : // xsd
            return;
    }
    if (~uri.indexOf('http://schemas.xmlsoap.org/')) return;
    if (~uri.indexOf('http://www.w3.org/')) return;
    if (~uri.indexOf('http://xml.apache.org/')) return;
    parts.push("xmlns:" + pfx + "=\"" + uri + "\"");
  });
  var attr = parts.join(' ');
  console.log("Computed xmlns attribute:", attr);
  return attr;
};

XMLNS.prototype.toString = function() {
  return "XMLNS " + require("util").inspect(this.prefixToUri);
};

XMLNS.prototype.getPrefix = function(uri, defaultPfx) {
  //console.log("Getting prefix for '%s' from %s", uri, this);
  var pfx = this.uriToPrefix[uri];
  if (!pfx && defaultPfx) {
    var oldUri = this.prefixToUri[defaultPfx];
    if (oldUri && oldUri != uri) {
      if (this.defaulter) {
        pfx = this.defaulter.getNsPrefix(uri);
      }
      else {
        pfx = "tns" + this.nextGen++;
      }
    }
    else {
      pfx = defaultPfx;
    }
    this.add(pfx, uri);
  }
  //console.log("Got prefix '%s' for '%s'", pfx, uri);
  this.used[pfx] = uri;
  return pfx;
};

var ParsedObject = exports.ParsedObject = function(definition, uri, options) {
    var self = this,
        fromFunc;

    this.uri = uri;
    this.callback = function() {};
    this.options = options || {};

    if (typeof definition === 'string') {
        fromFunc = this._fromXML;
    }
    else if (typeof definition === 'object') {
        fromFunc = this._fromServices;
    }
    else {
        throw new Error('WSDL constructor takes either an XML string or service definition');
    }

    process.nextTick(function() {
        fromFunc.call(self, definition);

        self.processIncludes(function(err) {
            if (err) {
              console.log("Error processing includes", err);
            }
            self.definitions.deleteFixedAttrs();
            var services = self.services = self.definitions.services ;
            if (services) {
                for (var name in services) {
                    services[name].postProcess(self.definitions);
                }
            }
            var complexTypes = self.definitions.complexTypes;
            if (complexTypes) {
                Object.keys(complexTypes).forEach(function(name) {
                  //console.log("Postprocessing complext type: %s =>", name, require("util").inspect(complexTypes[name], true, 10, true));
                  complexTypes[name].deleteFixedAttrs();
                });
            }

            // for document style, for every binding, prepare input message element name to (methodName, output message element name) mapping
            var bindings = self.definitions.bindings;
            for(var bindingName in bindings) {
                var binding = bindings[bindingName];
                if(binding.style !== 'document') continue;
                var methods = binding.methods;
                var topEls = binding.topElements = {};
                for(var methodName in methods) {
                    var inputName = methods[methodName].input.$name;
                    var outputName = methods[methodName].output.$name;
                    topEls[inputName] = {"methodName": methodName, "outputName": outputName};
                }
            }

            // prepare soap envelope xmlns definition string
            self.xmlnsInEnvelope = self._xmlnsMap();

            self.callback(err, self);
        });

    })
}

ParsedObject.prototype.onReady = function(callback) {
    if (callback) this.callback = callback;
}

ParsedObject.prototype._processNextInclude = function(basex, includes, callback) {
    var self = this,
        include = includes.shift();

    if (!include) return callback();

    var base = include.base || basex;

    var includePath;
    if (!/^http/.test(base) && !/^http/.test(include.location)) {
        includePath = path.resolve(path.dirname(base), include.location);
    } else {
        includePath = url.resolve(base, include.location);
    }

  if (!include.base) {
    include.base = base;
  }
  console.log("Processing include:", include);

    open_wsdl(includePath, function(err, wsdl) {
        if (err) {
            return callback(err);
        }

        self.definitions.schemas[include.namespace || wsdl.definitions.$targetNamespace] = wsdl.definitions;
        for (var ns in wsdl.definitions.schemas) {
          self.definitions.schemas[ns] = wsdl.definitions.schemas[ns];
        }

        self._processNextInclude(includePath, wsdl.definitions.includes, function(err) {
          if (err) {
            callback(err);
          }
          else {
            self._processNextInclude(base, includes, function(err) {
              callback(err);
            })
          }
        });

    });
}

ParsedObject.prototype.processIncludes = function(callback) {
    var schemas = this.definitions.schemas,
        includes = [];

    for (var ns in schemas) {
        var schema = schemas[ns];
        includes = includes.concat(schema.includes || [])
    }

    this._processNextInclude(this.uri, includes, callback);
}

ParsedObject.prototype.describeServices = function() {
    var services = {};
    for (var name in this.services) {
        var service = this.services[name];
        services[name] = service.description(this.definitions);
    }
    return services;
}

ParsedObject.prototype.toXML = function() {
    return this.xml || '';
}

ParsedObject.prototype.xmlToObject = function(xml) {
  console.log("xmlToObject:", xml);
    var self = this,
        p = new expat.Parser('UTF-8'),
        objectName = null,
        root = {},
        schema = {
            Envelope: {
                Header: {
                        Security: {
                            UsernameToken: {
                                Username: 'string',
                                Password: 'string' }}},
                Body: {
                    Fault: { faultcode: 'string', faultstring: 'string', detail: 'string' }}}},
        stack = [{name: null, object: root, schema: schema}];

    var refs = {}, id; // {id:{hrefs:[],obj:}, ...}

    p.on('startElement', function(nsName, attrs) {
        var name = splitNSName(nsName).name,
            top = stack[stack.length-1],
            topSchema = top.schema,
            obj = {};
        var originalName = name;

        if (!objectName && top.name === 'Body' && name !== 'Fault') {
            var message = self.definitions.messages[name];
            // Support RPC/literal messages where response body contains one element named
            // after the operation + 'Response'. See http://www.w3.org/TR/wsdl#_names
            if (!message) {
               // Determine if this is request or response
               var isInput = false;
               var isOutput = false;
               if ((/Response$/).test(name)) {
                 isOutput = true;
                 name = name.replace(/Response$/, '');
               } else if ((/Request$/).test(name)) {
                 isInput = true;
                 name = name.replace(/Request$/, '');
               } else if ((/Solicit$/).test(name)) {
                 isInput = true;
                 name = name.replace(/Solicit$/, '');
               }
               // Look up the appropriate message as given in the portType's operations
               var portTypes = self.definitions.portTypes;
               var portTypeNames = Object.keys(portTypes);
               // Currently this supports only one portType definition.
               var portType = portTypes[portTypeNames[0]];
               if (isInput) name = portType.methods[name].input.$name;
               else name = portType.methods[name].output.$name;
               message = self.definitions.messages[name];
               // 'cache' this alias to speed future lookups
               self.definitions.messages[originalName] = self.definitions.messages[name];
            }

            topSchema = message.description(self.definitions);
            objectName = originalName;
        }

				if(attrs.href) {
					id = attrs.href.substr(1);
					if(!refs[id]) refs[id] = {hrefs:[],obj:null};
					refs[id].hrefs.push({par:top.object,key:name});
				}
				if(id=attrs.id) {
					if(!refs[id]) refs[id] = {hrefs:[],obj:null};
				}

        if (topSchema && topSchema[name+'[]']) name = name + '[]';
        stack.push({name: originalName, object: obj, schema: topSchema && topSchema[name], id:attrs.id});
    })

    p.on('endElement', function(nsName) {
        var cur = stack.pop(),
						obj = cur.object,
            top = stack[stack.length-1],
            topObject = top.object,
            topSchema = top.schema,
            name = splitNSName(nsName).name;

        if (topSchema && topSchema[name+'[]']) {
            if (!topObject[name]) topObject[name] = [];
            topObject[name].push(obj);
        }
        else if (name in topObject) {
            if (!Array.isArray(topObject[name])) {
                topObject[name] = [topObject[name]];
            }
            topObject[name].push(obj);
        }
        else {
            topObject[name] = obj;
        }

				if(cur.id) {
					refs[cur.id].obj = obj;
				}
    })

    p.on('text', function(text) {
        text = trim(text);
        if (!text.length) return;

        var top = stack[stack.length-1];
        var name = splitNSName(top.schema).name,
            value;
        if (name === 'int' || name === 'integer') {
            value = parseInt(text, 10);
        } else if (name === 'bool' || name === 'boolean') {
            value = text.toLowerCase() === 'true' || text === '1';
        } else if (name === 'dateTime') {
            value = new Date(text);
        } else {
            // handle string or other types
            if (typeof top.object !== 'string') {
                value = text;
            } else {
                value = top.object + text;
            }
        }
        top.object = value;
    });

    if (!p.parse(xml, false)) {
        throw new Error(p.getError());
    }

		for(var n in refs) {
			var ref = refs[n];
			var obj = ref.obj;
			ref.hrefs.forEach(function(href) {
				href.par[href.key] = obj;
			});
		}

    var body = root.Envelope.Body;
    if (body.Fault) {
        throw new Error(body.Fault.faultcode+': '+body.Fault.faultstring+(body.Fault.detail ? ': ' + body.Fault.detail : ''));
    }
    return root.Envelope;
}

ParsedObject.prototype.getType = function(ns, name) {
  var schema = this.definitions.schemas[ns],
      type = schema ? schema.complexTypes[name] : null;
  console.log("NS", ns, "Name", name, "Type", type);
  return type;
}

ParsedObject.prototype.objectToDocumentXML = function(name, params, element, xmlns) {
    var args = {};
    args[name] = params;

    var inspect = require("util").inspect;

    console.log("Converting", params, "with [", name, "] as", inspect(element));

    //console.log("Definitions:", require("util").inspect(this.definitions, true, 10, true));

    return this.objectToXML(params, [name], element, element.targetNSAlias, element.targetNamespace, xmlns);
}

ParsedObject.prototype.objectToRpcXML = function(name, params, namespace, xmlns) {
    var self = this,
        parts = [],
        defs = this.definitions,
        namespace = namespace || findKey(defs.xmlns, xmlns),
        xmlns = xmlns || defs.xmlns[namespace],
        nsAttrName = '_xmlns';
    parts.push(['<',namespace,':',name,'>'].join(''));
    for (var key in params) {
        if (key != nsAttrName) {
            var value = params[key];
            parts.push(['<',key,'>'].join(''));
            parts.push((typeof value==='object')?this.objectToXML(value):xmlEscape(value));
            parts.push(['</',key,'>'].join(''));
        }
    }
    parts.push(['</',namespace,':',name,'>'].join(''));

    return parts.join('');
}


ParsedObject.prototype.compileNsPrefix = function() {
  var self = this;
  var schemas = self.definitions.schemas;
  var defaultNamespace = this.defaultNamespace;
  each(schemas, function(uri, schema) {
    each(schema.complexTypes, function(name, complexType) {
      add(complexType);
    });

    function add(e) {
      if (e.name == "element") {
        defaultNamespace[e.$name] = schema; // { nsUri : schema.$targetNamespace };
      }
      if (e.children) {
        for (var i = 0; i < e.children.length; i++) {
          add(e.children[i]);
        }
      }
    }
  });
};

ParsedObject.prototype.getNsPrefix = function(path, nsMap) {
  var name = path[path.length-1];
  var schema = this.defaultNamespace[name], nsUri, nsPrefix;
  if (schema) {
    nsUri = schema.$targetNamespace;
    nsPrefix = schema.nsPrefix;
  }
  if (nsUri) {
    var pfx = nsMap[nsUri];
    if (!pfx) {
      if (nsPrefix) {
        pfx = nsMap[nsUri] = nsPrefix;
      }
    }
    return pfx;
  }
  return null;
};

ParsedObject.prototype.getTypeElementMap = function(type, map, ns) {
  var wsdl = this;
  if (!map) map = {};
  if (type && type.children) {
    type.children.forEach(function(child) {
      if (child.name == "element") {
        console.log("Adding element:", child.$name);
        map[child.$name] = child;
        if (!child.$targetNamespace) child.$targetNamespace = ns;
      }
      else if (child.name == "sequence" || child.name == "choice") {
        wsdl.getTypeElementMap(child, map, ns);
      }
    });
  }
  return map;
};

ParsedObject.prototype.newXMLNS = function() {
  return new XMLNS();
}

ParsedObject.prototype.objectToXML = function(obj, path, element, nsPrefix, nsUri, xmlns) {
  var parts = [];
  this.appendObjectToXML(parts, obj, path, element, nsPrefix, nsUri, xmlns||this.newXMLNS());
  return parts.join('');
};

ParsedObject.prototype.appendObjectToXML = function(parts, obj, path, element, nsPrefix, nsUri, xmlns) {
  var self = this,
      name = path[path.length-1];

  //var colon = element.$type.indexOf(':');
  //var typeName = element.$type.substring(colon+1);
  nsUri = element.targetNamespace||element.$targetNamespace||nsUri;
  //var type = this.getType(nsUri, typeName);

  console.log(" ---- TO XML ----");

  var typeRef = element.$type;
  var colon = typeRef ? typeRef.indexOf(':') : -1;
  var typePfx = colon < 0 ? '' : typeRef.substring(0, colon);
  var typeName = colon < 0 ? typeRef : typeRef.substring(colon+1);
  var elementSchema = self.definitions.schemas[nsUri];
  var typeNs;
  if (elementSchema) {
    typeNs = elementSchema.xmlns[typePfx];
  }
  else {
    typeNs = self.definitions.xmlns[typePfx];
  }
  var schema = self.definitions.schemas[typeNs],
      type;

  if (schema) {
    type = schema.complexTypes[typeName];
    if (type) {
      console.log("Found complex type:", typeName);
    }
    else {
      type = schema.types[typeName];
      if (type) {
        console.log("Found simple type:", typeName);

      }
      else {
        console.log("Could not find type:", typeName, "in schema", schema);
      }
    }
  }
  else {
    type = null;
    if (typeNs == "http://www.w3.org/2001/XMLSchema") {
      console.log("Found XMLSchema namespace, falling back to:", nsUri);
      typeNs = nsUri;
      typePfx = nsPrefix;
    }
    else {
      console.log("Could not find schema:", typeNs, schema);
    }
  }

  var elementMap = {};
  console.log("Path:", path, "Element:", element.$name, "Type Prefix:", typePfx, "Namespace:", typeNs, "Name:", typeName, "Type:", type);
  if (typeRef) {
    console.log("Element Map:", self.getTypeElementMap(type, elementMap, typeNs));
  }

  var xmlnsAttrib = '', pfx, ns;

  var childElement;
  pfx = xmlns.getPrefix(typeNs, elementSchema.targetNsPrefix||elementSchema.$targetNSPrefix||"tns") || nsPrefix;
  ns = pfx ? pfx + ':' : '';

  if (Array.isArray(obj)) {
    for (var i=0, item; item=obj[i]; i++) {
      parts.push(['<',ns,name,xmlnsAttrib,'>'].join(''));
      self.appendObjectToXML(parts, item, path, element, pfx, typeNs, xmlns);
      parts.push(['</',ns,name,'>'].join(''));
    }
  }
  else if (typeof obj === 'object') {
    parts.push(['<',ns,name,xmlnsAttrib,'>'].join(''));
    Object.keys(obj).forEach(function(name) {
      var child = obj[name];
      childElement = elementMap[name]||{};
      path.push(name);
      self.appendObjectToXML(parts, child, path, childElement, pfx, typeNs, xmlns);
      path.pop();
    });
    parts.push(['</',ns,name,'>'].join(''));
  }
  else if (obj) {
    parts.push(['<',ns,name,xmlnsAttrib,'>'].join(''));
    parts.push(xmlEscape(obj));
    parts.push(['</',ns,name,'>'].join(''));
  }
  console.log("objectToDocumentXML", parts.join(''));
};

ParsedObject.prototype.XappendObjectToXML = function(parts, obj, path, element, nsPrefix, nsUri, nsMap) {
    var self = this,
        name = path[path.length-1];

  //var colon = element.$type.indexOf(':');
  //var typeName = element.$type.substring(colon+1);
  nsUri = nsUri||element.targetNamespace||element.$targetNamespace;
  //var type = this.getType(nsUri, typeName);

  console.log(" ---- TO XML ----");

    var typeRef = element.$type;
    var colon = typeRef ? typeRef.indexOf(':') : -1;
    var typePfx = colon < 0 ? '' : typeRef.substring(0, colon);
    var typeName = colon < 0 ? typeRef : typeRef.substring(colon+1);
    var elementSchema = self.definitions.schemas[nsUri];
    var typeNs = (elementSchema ? elementSchema : self.definitions).xmlns[typePfx];
    var schema = self.definitions.schemas[typeNs];
    var type = schema ? schema.complexTypes[typeName] : null;

    var elementMap = {};
    console.log("Path:", path, "Element:", element.$name, "Type Prefix:", typePfx, "Namespace:", typeNs, "Name:", typeName, "Type:", type);
    if (typeRef) {
      console.log("Element Map:", self.getTypeElementMap(type, elementMap));
    }

    //console.log("Path:", path, "Type:", require("util").inspect(element, 3));

    var xmlnsAttrib = '', pfx, ns;


    //if (!pfx && nsPrefix) {
    //  nsMap[nsUri] = nsPrefix;
    //  xmlnsAttrib += ' xmlns:'+nsPrefix+'="'+nsUri+'"'+' xmlns="'+nsUri+'"';
    //}

    var childElement;

    if (Array.isArray(obj)) {
        childElement = elementMap[name]||{};
        pfx = nsPrefix; //self.getNsPrefix(path, nsMap);
        ns = pfx ? pfx + ':' : '';
        for (var i=0, item; item=obj[i]; i++) {
            if (i > 0) {
                parts.push(['</',ns,name,'>'].join(''));
                parts.push(['<',ns,name,xmlnsAttrib,'>'].join(''));
            }
            self.appendObjectToXML(parts, item, path, childElement, null, null, nsMap);
            //parts.push(self.objectToXML(item, path, null, null, nsMap));
        }
    }
    else if (typeof obj === 'object') {
        Object.keys(obj).forEach(function(name) {
          var child = obj[name];
          childElement = elementMap[name]||{};
          path.push(name);
          pfx = nsPrefix; //self.getNsPrefix(path, nsMap);
          ns = pfx ? pfx + ':' : '';
          parts.push(['<',ns,name,xmlnsAttrib,'>'].join(''));
          self.appendObjectToXML(parts, child, path, childElement, null, null, nsMap);
          //parts.push(self.objectToXML(child, path, null, null, nsMap));
          parts.push(['</',ns,name,'>'].join(''));
          path.pop();
        });
    }
    else if (obj) {
        parts.push(xmlEscape(obj));
    }
  console.log("objectToDocumentXML", parts.join(''));
    //return parts.join('');
}

ParsedObject.prototype._parse = function(xml)
{
    var self = this,
        p = new expat.Parser('UTF-8'),
        stack = [],
        root = null;

    p.on('startElement', function(nsName, attrs) {
        var top = stack[stack.length - 1];
        if (top) {
            try {
                top.startElement(stack, nsName, attrs);
            }
            catch(e) {
                if (self.options.strict) {
                    throw e;
                }
                else {
                    stack.push(new Element(nsName, attrs));
                }
            }
        }
        else {
            var name = splitNSName(nsName).name;
            if (name === 'definitions') {
                root = new DefinitionsElement(nsName, attrs);
            }
            else if (name === 'schema') {
                root = new SchemaElement(nsName, attrs);
            }
            else {
                throw new Error('Unexpected root element of WSDL or include');
            }
            stack.push(root);
        }
    })

    p.on('endElement', function(name) {
        var top = stack[stack.length - 1];
        assert(top, 'Unmatched close tag: ' + name);

        top.endElement(stack, name);
    })

    if (!p.parse(xml, false)) {
        throw new Error(p.getError());
    }

    return root;
}

ParsedObject.prototype._fromXML = function(xml) {
    this.definitions = this._parse(xml);
    this.xml = xml;
}

ParsedObject.prototype._fromServices = function(services) {

}



ParsedObject.prototype._xmlnsMap = function() {
    var xmlns = this.definitions.xmlns;
    var str = '';
    for (var alias in xmlns) {
        if (alias === '') continue;
        var ns = xmlns[alias];
        switch(ns) {
            case "http://xml.apache.org/xml-soap" : // apachesoap
            case "http://schemas.xmlsoap.org/wsdl/" : // wsdl
            case "http://schemas.xmlsoap.org/wsdl/soap/" : // wsdlsoap
            case "http://schemas.xmlsoap.org/soap/encoding/" : // soapenc
            case "http://www.w3.org/2001/XMLSchema" : // xsd
                continue;
        }
        if (~ns.indexOf('http://schemas.xmlsoap.org/')) continue;
        if (~ns.indexOf('http://www.w3.org/')) continue;
        if (~ns.indexOf('http://xml.apache.org/')) continue;
        str += ' xmlns:' + alias + '="' + ns + '"';
    }
    return str;
}

function open_xml(parsedObject, uri, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    var parsed;
    if (!/^http/.test(uri)) {
        fs.readFile(uri, 'utf8',  function (err, definition) {
            if (err) {
                callback(err)
            }
            else {
                parsed = new parsedObject(definition, uri, options);
                parsed.onReady(callback);
            }
        })
    }
    else {
        http.request(uri, null, function (err, response, definition) {
            if (err) {
                callback(err);
            }
            else if (response && response.statusCode == 200) {
                parsed = new parsedObject(definition, uri, options);
                parsed.onReady(callback);
            }
            else {
              console.log("Got response", response, definition);
                callback(new Error('Invalid URL: ' + uri));
            }
        });
    }

    return parsed;
}

exports.open_xml = open_xml;


