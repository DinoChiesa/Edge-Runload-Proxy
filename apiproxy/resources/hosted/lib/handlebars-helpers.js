// handlebars-helpers.js
// ------------------------------------------------------------------
//
// created: Fri Feb  2 15:36:32 2018
// last saved: <2019-June-24 10:29:28>
/* global Buffer */

(function (){
  'use strict';
  const Handlebars = require('handlebars'),
        WeightedRandomSelector = require('./weightedRandomSelector.js');
  let helpers = {};
  let rStringChars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  var isNumber = function(n) {
        return (typeof n === 'number');
      };

  helpers.base64 = function(s) {
    var a = Buffer.from(s).toString('base64');
    return a;
  };

  helpers.json = function(obj) {
    return JSON.stringify(obj);
  };

  helpers.httpbasicauth = function(u, p) {
    let userpass =
      (Object.prototype.toString.call(p) === '[object String]' &&
       Object.prototype.toString.call(u) === '[object String]')
      ? u + ':' + p
      : u;
    var a = Buffer.from(userpass || 'unknown').toString('base64');
    return 'Basic ' + a;
  };

  helpers.random = function(min, max) {
    if (!isNumber(min)) {
      //throw new Error('expected minimum to be a number');
      min = 0;
    }
    if (!isNumber(max)) {
      //throw new Error('expected maximum to be a number');
      max = 1000000;
    }
    return Math.floor( (Math.random() * (max - min))) + min;
  };

  helpers.randomSelect = function(a){
    if ( ! Array.isArray(a)) {
      console.log('randomSelect: ERROR');
      throw new Error('expected a to be an array');
    }
    var L = a.length;
    var s = a[Math.floor((Math.random() * L))];
    console.log('randomSelect: ' + JSON.stringify(s));
    if (typeof s === 'string') {
      return s;
    }
    //return JSON.stringify(s);
    return s;
  };

  helpers.split = function(s, separator){
    var pieces = s.split(separator);
    return pieces;
  };

  helpers.jsonprop = function(json,prop) {
    var o = JSON.parse(json);
    var v = o[prop];
    console.log('jsonprop: ' + v);
    return v;
  };

  helpers.index_of = function(context,ndx) {
    // input can be presented as a string. This can happen because
    // handlebars can coerce it. If so, split it to an array.
    // Even if originally it was an array,
    if ( ! Array.isArray(context)) {
      context = context.split(',');
    }
    return context[ndx];
  };

  helpers.randomString = function(length) {
    var i, result = '';
    if (Object.prototype.toString.call(length) === '[object Object]') {
      length = 0;
    }
    length = length || Math.ceil((Math.random() * 28)) + 12;
    length = Math.abs(Math.min(length, 1024));
    for (i = length; i > 0; --i) {
      result += rStringChars[Math.round(Math.random() * (rStringChars.length - 1))];
    }
    return result;
  };

  helpers.weightedRandomSelect = function(aa) {
    var wrs = new WeightedRandomSelector(aa);
    var result = wrs.select()[0];
    if (Object.prototype.toString.call(result) === '[object String]') {
      return new Handlebars.SafeString(result);
    }
    return JSON.stringify(result);
  };

  function registerHelpers() {
    // register them all
    Object.keys(helpers).forEach( key => Handlebars.registerHelper(key, helpers[key]) );
  }

  module.exports = registerHelpers;

}());
