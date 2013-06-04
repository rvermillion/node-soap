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
    assert = require('assert').ok,
    Element = require("./xml").Element,
    XMLNS = require("./xml").XMLNS;

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
    return null;
}

var InputElement = Element.createSubClass();
var OutputElement = Element.createSubClass();
var MessageElement = Element.createSubClass();

var SchemaElement = require("./schema").SchemaElement;
var TypesElement = Element.createSubClass();
var OperationElement = Element.createSubClass();
var PortTypeElement = Element.createSubClass();
var BindingElement = Element.createSubClass();
var PortElement = Element.createSubClass();
var ServiceElement = Element.createSubClass();
var DefinitionsElement = Element.createSubClass();

var ElementTypeMap = {
    types: [TypesElement, 'schema'],
    schema: [SchemaElement], //, 'element complexType simpleType include import'],

    service: [ServiceElement, 'port documentation'],
    port: [PortElement, 'address'],
    binding: [BindingElement, '_binding SecuritySpec operation'],
    portType: [PortTypeElement, 'operation'],
    message: [MessageElement, 'part documentation'],
    operation: [OperationElement, 'documentation input output fault _operation'],
    input : [InputElement, 'body SecuritySpecRef documentation header'],
    output : [OutputElement, 'body SecuritySpecRef documentation header'],
    fault : [Element, '_fault'],
    definitions: [DefinitionsElement, 'types message portType binding service']
};

var mapElementTypes = require("./xml").mapElementTypes;

function each(o, f) {
  Object.keys(o).forEach(function(k) {
    f(k, o[k], o);
  });
}

each(ElementTypeMap, function(n, v) {
  var types = v[1];
  if (types) {
    v[0].prototype.allowedChildren = mapElementTypes(ElementTypeMap, types);
  }
});

MessageElement.prototype.init = function() {
    this.element = null;
    this.parts = null;
};
TypesElement.prototype.init = function() {
    this.schemas = {};
};
OperationElement.prototype.init = function() {
    this.input = null;
    this.output = null;
    this.inputSoap = null;
    this.outputSoap = null;
    this.style = '';
    this.soapAction = '';
};
PortTypeElement.prototype.init = function() {
    this.methods = {};
};
BindingElement.prototype.init = function() {
    this.transport = '';
    this.style = '';
    this.methods = {};
};
PortElement.prototype.init = function() {
    this.location = null;
};
ServiceElement.prototype.init = function() {
    this.ports = {};
};
DefinitionsElement.prototype.init = function() {
    if (this.name !== 'definitions') this.unexpected(nsName);
    this.messages = {};
    this.portTypes = {};
    this.bindings = {};
    this.services = {};
    this.schemas = {};
};

TypesElement.prototype.addChild = function(child) {
    assert(child instanceof SchemaElement);
    this.schemas[child.$targetNamespace] = child;
};
InputElement.prototype.addChild = function(child) {
    if (child.name === 'body') {
        this.use = child.$use;
        if (this.use === 'encoded') {
            this.encodingStyle = child.$encodingStyle;
        }
        this.children.pop();
    }
};
OutputElement.prototype.addChild = function(child) {
    if (child.name === 'body') {
        this.use = child.$use;
        if (this.use === 'encoded') {
            this.encodingStyle = child.$encodingStyle;
        }
        this.children.pop();
    }
};
OperationElement.prototype.addChild = function(child) {
    if (child.name === 'operation') {
        this.soapAction = child.$soapAction || '';
        this.style = child.$style || '';
        this.children.pop();
    }
};
BindingElement.prototype.addChild = function(child) {
    if (child.name === 'binding') {
        this.transport = child.$transport;
        this.style = child.$style;
        this.children.pop();
    }
};
PortElement.prototype.addChild = function(child) {
    if (child.name === 'address' && typeof(child.$location) !== 'undefined') {
       this.location = child.$location;
    }
};
DefinitionsElement.prototype.addChild = function(child) {
    var self = this;
    if (child instanceof TypesElement) {
        self.schemas = child.schemas;
    }
    else if (child instanceof MessageElement) {
        self.messages[child.$name] = child;
    }
    else if (child instanceof PortTypeElement) {
        self.portTypes[child.$name] = child;
    }
    else if (child instanceof BindingElement) {
        if (child.transport === 'http://schemas.xmlsoap.org/soap/http' ||
            child.transport === 'http://www.w3.org/2003/05/soap/bindings/HTTP/')
            self.bindings[child.$name] = child;
    }
    else if (child instanceof ServiceElement) {
        self.services[child.$name] = child;
    }
    else {
        assert(false, "Invalid child type");
    }
    this.children.pop();
};


MessageElement.prototype.postProcess = function(definitions) {
    var part = null, child,
        children = this.children || [],
        nsName,
        ns,
        i;

    for (i = 0; i < children.length; i++) {
      if ((child = children[i]).name === 'part') {
          part = child;
          break;
      }
    }

    if (!part) return;
    if (part.$element) {
        delete this.parts;
        nsName = splitNSName(part.$element);
        ns = nsName.namespace;
        this.element = definitions.schemas[definitions.xmlns[ns]].elements[nsName.name];
        if (!this.element) {
          console.log("No element with %s:%s:", ns, nsName.name, nsName);
          console.log("Schemas:", definitions.schemas);
          console.log("XMLNS:", definitions.xmlns);
        }
        this.element.targetNSAlias = ns;
        this.element.targetNamespace = definitions.xmlns[ns];
        this.children.splice(0,1);
    }
    else {
        // rpc encoding
        this.parts = {};
        delete this.element;
        for (i = 0; part = this.children[i]; i++) {
            assert(part.name === 'part', 'Expected part element');
            nsName = splitNSName(part.$type);
            ns = definitions.xmlns[nsName.namespace];
            var type = nsName.name;
            var schemaDefinition = definitions.schemas[ns];
            if (typeof schemaDefinition !== 'undefined') {
                this.parts[part.$name] = definitions.schemas[ns].types[type] || definitions.schemas[ns].complexTypes[type];
            } else {
                this.parts[part.$name] = part.$type;
            }
            this.parts[part.$name].namespace = nsName.namespace;
            this.parts[part.$name].xmlns = ns;
            this.children.splice(i--,1);
        }
    }
    this.deleteFixedAttrs();
};

OperationElement.prototype.postProcess = function(definitions, tag) {
    var children = this.children;
    for (var i=0, child; child=children[i]; i++) {
        if (child.name !== 'input' && child.name !== 'output') continue;
        if(tag === 'binding') {
            this[child.name] = child;
            children.splice(i--,1);
            continue;
        }
        var messageName = splitNSName(child.$message).name;
        var message = definitions.messages[messageName];
        message.postProcess(definitions);
        if (message.element) {
            definitions.messages[message.element.$name] = message;
            this[child.name] = message.element;
        }
        else {
            this[child.name] = message;
        }
        children.splice(i--,1);
    }
    this.deleteFixedAttrs();
};

PortTypeElement.prototype.postProcess = function(definitions) {
    var children = this.children;
    if (typeof children === 'undefined') return;
    for (var i=0, child; child=children[i]; i++) {
        if (child.name != 'operation') continue;
        child.postProcess(definitions, 'portType');
        this.methods[child.$name] = child;
        children.splice(i--,1);
    }
    delete this.$name;
    this.deleteFixedAttrs();
};

BindingElement.prototype.postProcess = function(definitions) {
    var type = splitNSName(this.$type).name,
        portType = definitions.portTypes[type],
        style = this.style,
        children = this.children;

    portType.postProcess(definitions);
    this.methods = portType.methods;
    // delete portType.methods; both binding and portType should keep the same set of operations

    for (var i=0, child; child=children[i]; i++) {
        if (child.name != 'operation') continue;
        child.postProcess(definitions, 'binding');
        children.splice(i--,1);
        child.style || (child.style = style);
        var method =  this.methods[child.$name];
        method.style = child.style;
        method.soapAction = child.soapAction;
        method.inputSoap = child.input || null;
        method.outputSoap = child.output || null;
        method.inputSoap && method.inputSoap.deleteFixedAttrs();
        method.outputSoap && method.outputSoap.deleteFixedAttrs();
        // delete method.$name; client will use it to make right request for top element name in body
        // method.deleteFixedAttrs(); why ???
    }

    delete this.$name;
    delete this.$type;
    this.deleteFixedAttrs();
};

ServiceElement.prototype.postProcess = function(definitions) {
    var children = this.children,
        bindings = definitions.bindings;
    for (var i=0, child; child=children[i]; i++) {
        if (child.name != 'port') continue;
        var bindingName = splitNSName(child.$binding).name;
        var binding = bindings[bindingName];
        if (binding) {
            binding.postProcess(definitions);
            this.ports[child.$name] = {
                location: child.location,
                binding: binding
            };
            children.splice(i--,1);
        }
    }
    delete this.$name;
    this.deleteFixedAttrs();
};

MessageElement.prototype.description = function(definitions) {
    if (this.element) {
        return this.element && this.element.description(definitions);
    }
    var desc = {};
    desc[this.$name] = this.parts;
    return desc;
};

PortTypeElement.prototype.description = function(definitions) {
    var methods = {};
    each(this.methods, function(name, method) {
      methods[name] = method.description(definitions);
    });
    return methods;
};

OperationElement.prototype.description = function(definitions) {
    var inputDesc = this.input.description(definitions);
    var outputDesc = this.output.description(definitions);
    return {
        input: inputDesc && inputDesc[Object.keys(inputDesc)[0]],
        output: outputDesc && outputDesc[Object.keys(outputDesc)[0]]
    };
};

BindingElement.prototype.description = function(definitions) {
    var methods = {};
    each(this.methods, function(name, method) {
      methods[name] = method.description(definitions);
    });
    return methods;
};
ServiceElement.prototype.description = function(definitions) {
    var ports = {};
    each(this.ports, function(name, port) {
      ports[name] = port.binding.description(definitions);
    });
    return ports;
};


var WSDL = function(definition, uri, options) {
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
                each(services, function(name, service) {
                  service.postProcess(self.definitions);
                });
            }
            var complexTypes = self.definitions.complexTypes;
            if (complexTypes) {
                each(complexTypes, function(name, complexType) {
                  //console.log("Postprocessing complext type: %s =>", name, require("util").inspect(complexTypes[name], true, 10, true));
                  complexType.deleteFixedAttrs();
                });
            }

            // for document style, for every binding, prepare input message element name to (methodName, output message element name) mapping
            var bindings = self.definitions.bindings;
            each(bindings, function(bindingName, binding) {
              if (binding.style !== 'document') return;
              var topEls = binding.topElements = {};
              each(binding.methods, function(methodName, method) {
                topEls[method.input.$name] = {
                  methodName : methodName,
                  outputName : method.output.$name
                };
              });
            });

            // prepare soap envelope xmlns definition string
            self.xmlnsInEnvelope = self._xmlnsMap();

            self.callback(err, self);
        });

    })
};

inherits(WSDL, require("./xml").ParsedObject);

WSDL.prototype._processNextInclude = function(basex, includes, callback) {
    var self = this,
        include = includes.shift();

    if (!include) {
      callback();
      return;
    }

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
            callback(err);
            return;
        }

        self.definitions.schemas[include.namespace || wsdl.definitions.$targetNamespace] = wsdl.definitions;
        each(wsdl.definitions.schemas, function(ns, schema) {
          self.definitions.schemas[ns] = schema;
        });
        //for (var ns in wsdl.definitions.schemas) {
        //  self.definitions.schemas[ns] = wsdl.definitions.schemas[ns];
        //}

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
};

WSDL.prototype.processIncludes = function(callback) {
    var schemas = this.definitions.schemas,
        includes = [];

    each(schemas, function(ns, schema) {
      if (schema.includes) {
        includes = includes.concat(schema.includes)
      }
    });

    this._processNextInclude(this.uri, includes, callback);
};

WSDL.prototype.describeServices = function() {
  var wsdl = this, services = {};
  each(this.services, function(name, service) {
    services[name] = service.description(wsdl.definitions);
  });
  return services;
};

WSDL.prototype.toXML = function() {
    return this.xml || '';
};

WSDL.prototype.xmlToObject = function(xml) {
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
    });

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
    });

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

    each(refs, function(n, ref) {
      var obj = ref.obj;
      ref.hrefs.forEach(function(href) {
        href.par[href.key] = obj;
      });
    });
		//for(var n in refs) {
		//	var ref = refs[n];
		//	var obj = ref.obj;
		//	ref.hrefs.forEach(function(href) {
		//		href.par[href.key] = obj;
		//	});
		//}
    if (!root.Envelope) {
        throw new Error("Could not parse XML: " + xml);
    }

    var body = root.Envelope.Body;
    if (body.Fault) {
        throw new Error(body.Fault.faultcode+': '+body.Fault.faultstring+(body.Fault.detail ? ': ' + body.Fault.detail : ''));
    }
    return root.Envelope;
};

WSDL.prototype.getType = function(ns, name) {
  var schema = this.definitions.schemas[ns],
      type = schema ? schema.complexTypes[name] : null;
  //console.log("NS", ns, "Name", name, "Type", type);
  return type;
};

WSDL.prototype.objectToDocumentXML = function(name, params, element, xmlns) {
    var args = {};
    args[name] = params;

    var inspect = require("util").inspect;

    //console.log("Converting", params, "with [", name, "] as", inspect(element));

    //console.log("Definitions:", require("util").inspect(this.definitions, true, 10, true));

    return this.objectToXML(params, [name], element, element.targetNSAlias, element.targetNamespace, xmlns);
};

WSDL.prototype.objectToRpcXML = function(name, params, namespace, xmlns) {
    var self = this,
        parts = [],
        defs = this.definitions,
        nsAttrName = '_xmlns';

    if (!namespace) namespace = findKey(defs.xmlns, xmlns);
    if (!xmlns) xmlns = defs.xmlns[namespace];

    parts.push(['<',namespace,':',name,'>'].join(''));
    each(params, function(key, value) {
      if (key != nsAttrName) {
          parts.push(['<',key,'>'].join(''));
          parts.push((typeof value==='object')?self.objectToXML(value):xmlEscape(value));
          parts.push(['</',key,'>'].join(''));
      }
    });
    parts.push(['</',namespace,':',name,'>'].join(''));

    return parts.join('');
};

WSDL.prototype.newXMLNS = function() {
  return new XMLNS(this.definitions.xmlns);
};

WSDL.prototype._parse = function(xml)
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
    });

    p.on('endElement', function(name) {
        var top = stack[stack.length - 1];
        assert(top, 'Unmatched close tag: ' + name);

        top.endElement(stack, name);
    });

    if (!p.parse(xml, false)) {
        throw new Error(p.getError());
    }

    return root;
};

WSDL.prototype._fromXML = function(xml) {
    this.definitions = this._parse(xml);
    this.xml = xml;
};

WSDL.prototype._fromServices = function(services) {

};



WSDL.prototype._xmlnsMap = function() {
    var xmlns = this.definitions.xmlns;
    var buff = [];
    each(xmlns, function(alias, ns) {
      if (alias === '') return;
      switch(ns) {
          case "http://xml.apache.org/xml-soap" : // apachesoap
            return;
          case "http://schemas.xmlsoap.org/wsdl/" : // wsdl
            return;
          case "http://schemas.xmlsoap.org/wsdl/soap/" : // wsdlsoap
            return;
          case "http://schemas.xmlsoap.org/soap/encoding/" : // soapenc
            return;
          case "http://www.w3.org/2001/XMLSchema" : // xsd
            return;
      }
      if (~ns.indexOf('http://schemas.xmlsoap.org/')) return;
      if (~ns.indexOf('http://www.w3.org/')) return;
      if (~ns.indexOf('http://xml.apache.org/')) return;
      buff.push(' xmlns:' + alias + '="' + ns + '"');
    });
    return buff.join('');
};

var open_xml = require("./xml").open_xml;

function open_wsdl(uri, options, callback) {
  return open_xml(WSDL, uri, options, callback);
}

exports.open_wsdl = open_wsdl;
exports.WSDL = WSDL;


