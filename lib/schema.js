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

var Primitives = {
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

function each(o, f) {
  Object.keys(o).forEach(function(k) {
    f(k, o[k], o);
  });
}

var Element = require("./xml").Element;

var ElementElement = Element.createSubClass();
var SimpleTypeElement = Element.createSubClass();
var RestrictionElement = Element.createSubClass();
var EnumerationElement = Element.createSubClass();
var ComplexTypeElement = Element.createSubClass();
var SequenceElement = Element.createSubClass();
var AllElement = Element.createSubClass();
var SchemaElement = Element.createSubClass();

exports.SchemaElement = SchemaElement;

var ElementTypeMap = {
    schema: [SchemaElement, 'element complexType simpleType include import'],
    element: [ElementElement, 'annotation complexType'],
    simpleType: [SimpleTypeElement, 'restriction'],
    restriction: [RestrictionElement, 'enumeration'],
    enumeration: [EnumerationElement, ''],
    complexType: [ComplexTypeElement,  'annotation sequence all'],
    sequence: [SequenceElement, 'element'],
    all: [AllElement, 'element'],
};

var mapElementTypes = require("./xml").mapElementTypes;


each(ElementTypeMap, function(n, v) {
  var types = v[1];
  if (types) {
    v[0].prototype.allowedChildren = mapElementTypes(ElementTypeMap, types);
  }
});

SchemaElement.prototype.init = function() {
    this.complexTypes = {};
    this.types = {};
    this.elements = {};
    this.includes = [];
}
SchemaElement.prototype.addChild = function(child) {
    if (child.$name in Primitives) return;
    if (child.name === 'include' || child.name === 'import') {
        var location = child.$schemaLocation || child.$location;
        if (location) {
            this.includes.push({
                namespace: child.$namespace || child.$targetNamespace || this.$targetNamespace,
                location: location
            });
        }
    }
    else if (child.name === 'complexType') {
        this.complexTypes[child.$name] = child;
    }
    else if (child.name === 'element') {
        this.elements[child.$name] = child;
    }
    else if (child.$name) {
        this.types[child.$name] = child;
    }
    this.children.pop();
    // child.deleteFixedAttrs();
}


SimpleTypeElement.prototype.description = function(definitions) {
    var children = this.children;
    for (var i=0, child; child=children[i]; i++) {
        if (child instanceof RestrictionElement)
           return this.$name+"|"+child.description();
    }
    return {};
}

RestrictionElement.prototype.description = function() {
    var base = this.$base ? this.$base+"|" : "";
    return base + this.children.map( function(child) {
       return child.description();
    } ).join(",");
}

EnumerationElement.prototype.description = function() {
   return this.$value;
}

ComplexTypeElement.prototype.description = function(definitions) {
    var children = this.children;
    for (var i=0, child; child=children[i]; i++) {
        if (child instanceof SequenceElement ||
            child instanceof AllElement) {
            return child.description(definitions);
        }
    }
    return {};
}
ElementElement.prototype.description = function(definitions) {
    var element = {},
        name = this.$name,
        schema;
    if (this.$minOccurs !== this.$maxOccurs) {
        name += '[]';
    }

    if (this.$type) {
        var typeName = splitNSName(this.$type).name,
            ns = definitions.xmlns[splitNSName(this.$type).namespace],
            schema = definitions.schemas[ns],
            typeElement = schema && ( schema.complexTypes[typeName] || schema.types[typeName] );
        if (typeElement && !(typeName in Primitives)) {
            element[name] = typeElement.description(definitions);
        }
        else
            element[name] = this.$type;
    }
    else {
        var children = this.children;
        element[name] = {};
        for (var i=0, child; child=children[i]; i++) {
            if (child instanceof ComplexTypeElement)
                element[name] = child.description(definitions);
        }
    }
    return element;
}
AllElement.prototype.description =
SequenceElement.prototype.description = function(definitions) {
    var children = this.children;
    var sequence = {};
    for (var i=0, child; child=children[i]; i++) {
        var description = child.description(definitions);
        for (var key in description) {
            sequence[key] = description[key];
        }
    }
    return sequence;
}

