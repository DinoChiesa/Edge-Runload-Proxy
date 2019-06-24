// runLoad-server.js
// ------------------------------------------------------------------
//
// Copyright © 2013-2016 Apigee Corp, and Copyright 2017-2019, Google Inc.
// All rights reserved.
//
// ------------------------------------------------------------------
'use strict';

const util = require('util'),
      process = require('process'),
      Handlebars = require('handlebars'),
      jsonpath = require('jsonpath'),
      request = require('./lib/slimNodeHttpClient.js'),
      ipGenerator = require('./lib/ipGenerator.js'),
      app = require('express')(),
      bodyParser = require('body-parser'),
      fs = require('fs'),
      dayNames = [ 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday' ],
      oneHourInMs = 60 * 60 * 1000,
      minSleepTimeInMs = 120,
      maxIterations = 50,
      defaultConfigFile = './config/model.json',
      log = new Log();

var cache = null,
    globals = {},
    defaults = null,
    g = {
      context : null,
      status : {
        version : '20190624-1057',
        pid : process.pid,
        nRequests : 0,
        nCycles : 0,
        times : {
          start : (new Date()).toISOString(),
          lastRun : (new Date()).toISOString()
        },
        jobId : '',
        description : '',
        runState : 'none',
        responseCounts : { total: 0 }
      },
    };
    //isUrl = new RegExp('^https?://[-a-z0-9\\.]+($|/)', 'i');

require('./lib/handlebars-helpers.js')();

function Gaussian(mean, stddev) {
  this.mean = mean;
  this.stddev = stddev || mean * 0.1;
  this.next = function() {
    return this.stddev * normal() + 1 * mean;
  };

  /*
    Function normal.

    Generator of pseudo-random number according to a normal distribution
    with mean=0 and variance=1.
    Use the Box-Mulder (trigonometric) method, and discards one of the
    two generated random numbers.
  */

  function normal() {
    var u1 = 0, u2 = 0;
    while (u1 * u2 === 0) {
      u1 = Math.random();
      u2 = Math.random();
    }
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

function Log() { }

Log.prototype.write = function(level, varargs) {
  var time = (new Date()).toString();
  var args = Array.prototype.slice.call(arguments, 1);
  if (g.status.loglevel >= level) {
    var tstr = '[' + time.substr(11, 4) + '-' +
      time.substr(4, 3) + '-' + time.substr(8, 2) + ' ' +
      time.substr(16, 8) + '] ';
    console.log( tstr + util.format.apply(util, args));
  }
};

function isNumber(n) {
  if (typeof n === 'undefined') { return false; }
  // the variable is defined
  return !isNaN(parseFloat(n)) && isFinite(n);
}

function trackFailure(reason) {
  if (reason) {
    log.write(0,'failure: ' + reason);
    log.write(1, reason.stack);
    g.status.lastError = {
      message: reason.stack.toString(),
      time: (new Date()).toISOString()
    };
  }
  else {
    log.write(0,'unknown failure?');
  }
}

function cacheKey(tag) {
  return 'runload-'  + tag + '-' + (g.model.id || 'xxx');
}

/**
 * expandEmbeddedTemplates walks through an object, replacing each embedded
 * template as appropriate. This is used to expand a templated payload.
 **/
function expandEmbeddedTemplates(obj) {
  var newObj, tmpl,
      type = Object.prototype.toString.call(obj), i;

  if (type === '[object String]') {
    tmpl = Handlebars.compile(obj);
    newObj = tmpl(g.context);
  }
  else if (type === '[object Array]') {
    // iterate
    newObj = [];
    for (i=0; i<obj.length; i++) {
      newObj.push(expandEmbeddedTemplates(obj[i], g.context));
    }
  }
  else if (type === '[object Object]') {
    newObj = {};
    Object.keys(obj).forEach(function(prop){
      var type = Object.prototype.toString.call(obj[prop]);
      if (type === '[object String]') {
        // replace all templates in a string
        tmpl = Handlebars.compile(obj[prop]);
        newObj[prop] = tmpl(g.context);
      }
      else if (type === '[object Object]' || type === '[object Array]') {
        // recurse
        newObj[prop] = expandEmbeddedTemplates(obj[prop]);
      }
      else {
        // no replacement
        newObj[prop] = obj[prop];
      }
    });
  }
  return newObj;
}

// ==================================================================

function resolveExpression(input, defaultValue) {
  var I = input;
  if (typeof input === 'undefined') {
    I = defaultValue;
  }
  else if (typeof input === 'string') {
    I = eval('(' + input + ')');
  }
  return I;
}


function getLoadGeneratorSource(){
  let source = ['org', 'env', 'proxy'].map(x => globals[x]).join(':');
  if ( ! source || source === '::' ) {
    source = process.env.HOSTNAME || process.env.HOST || 'not-known';
  }
  return source;
}

function invokeOneRequest(linkUrl, method, payload, headers, job) {
  return new Promise(function(resolve, fail) {
    method = method.toLowerCase();
    var options = {
          uri : linkUrl,
          method: method,
          followRedirects: false,
          headers: headers
        };

    function cb(e, httpResp, body) {
      var aIndex;
      g.status.nRequests++;
      if (e) {
        log.write(2, 'respCallback: ' + e);
        return resolve({});
      }
      log.write(2, '%s %s  ==> %d', options.method.toUpperCase(), options.uri, httpResp.statusCode);
      // keep a count of status codes
      aIndex = httpResp.statusCode + '';
      if (g.status.responseCounts.hasOwnProperty(aIndex)) {
        g.status.responseCounts[aIndex]++;
      }
      else {
        g.status.responseCounts[aIndex] = 1;
      }
      g.status.responseCounts.total++;
      try {
        body = JSON.parse(body);
      }
      catch (e) {
      }
      return resolve({body, headers: httpResp.headers, status: httpResp.statusCode });
    }

    options.headers['x-runload-source'] = getLoadGeneratorSource();

  if (job.simulateGeoDistribution) {
    let selected = ipGenerator.generateIp();
    log.write(5, 'selected client IP = %s', JSON.stringify(selected));
    options.headers['x-forwarded-for'] = selected.ip;
  }
  else {
    log.write(5,'not contriving an IP');

  }
  log.write(8, 'headers ' + JSON.stringify(options.headers));


    if ((method === 'post') || (method === 'put')) {
      log.write(6,'expanding templates...');
      payload = expandEmbeddedTemplates(payload);
      log.write(6,'payload: ' + JSON.stringify(payload));
      var t2 = Object.prototype.toString.call(payload);
      if (t2 === '[object String]') {
        options.body = payload;
        // set header explicitly if not already set
        if (!options.headers['content-type']) {
          options.headers['content-type'] = 'application/x-www-form-urlencoded';
        }
      }
      else {
        // in this case the content-type header gets set implicitly by the library
        options.json = payload;
      }
    }
    log.write(5, '%s %s', options.method.toUpperCase(), options.uri);
    request(options, cb);
  });
}

function evalJavascript(code, ctx) {
  var values = [], names = [], result = '';

  // create the fn signature
  Object.keys(ctx).forEach(function(prop){
    names.push(prop);
    values.push(ctx[prop]);
  });

  code = code.trim();
  let src = (code.endsWith(';')) ? code : 'return (' + code +');';
  log.write(9,'evalJavascript: ' + src);
  try {
    let f = new Function(names.join(','), src);
    log.write(9, 'fn: ' + f.toString());
    // call the function with all its arguments
    result = f.apply(null, values);
  }
  catch (exc1) {
    log.write(3,'evalJavascript, exception: ' + exc1.toString());
    result = '';
  }
  log.write(7,'evalJavascript, result: ' + result);
  return result;
}

function resolveExtract(payload, headers, status, extracts) {
  return function(name) {
    let value = extracts[name];
    if (name && value) {
      if (value.startsWith('{{') && value.endsWith('}}')) {
        log.write(4, 'extract: handlebars...');
        // handlebars
        let template = Handlebars.compile(value, {noEscape:true});
        let result = template(g.context);
        log.write(4, 'extract: context[%s] = %s', name, result);
        g.context[name] = result;
      }
      else if (value.startsWith('{') && value.endsWith('}')) {
        // eval, because sometimes I don't want a string.
        log.write(4, 'extract: evalJavascript...');
        let result = evalJavascript(value.slice(1, -1), Object.assign(g.context, {payload, headers, status}) );
        log.write(4, 'extract: context[%s] = %s', name, JSON.stringify(result));
        g.context[name] = result;
      }
      else {
        log.write(4, 'extract: jsonpath...');
        // jsonpath
        try {
          // https://www.npmjs.com/package/jsonpath
          let result = jsonpath.query(payload, value);
          log.write(4, 'extract: context[%s] = %s', name, JSON.stringify(result));
          g.context[name] = (Array.isArray(result) && result.length === 1) ? result[0] : result;
        }
        catch (e) {
          // gulp
        }
      }
    }
  };
}

function invokeOneBatchOfRequests(r, job) {
  if (r.imports) {
    Object.keys(r.imports).forEach(function(name){
      var s = r.imports[name];
      try {
        if (s.startsWith('{{') && s.endsWith('}}')) {
          // handlebars
          let tmpl = Handlebars.compile(s);
          let result = tmpl(g.context);
          log.write(4, 'import: context[%s] = %s', name, result);
          g.context[name] = result;
        }
        else if (s.startsWith('{') && s.endsWith('}')) {
          // eval, because sometimes I don't want a string.
          let result = evalJavascript(s.slice(1, -1), g.context);
          log.write(4, 'import: context[%s] = %s', name, JSON.stringify(result));
          g.context[name] = result;
        }
      }
      catch(e) {
        log.write(2, 'exception while applying import template: ' + r.imports[name]);
        log.write(2, 'exception: ' + e);
      }
    });
  }

  var linkUrl = r.url || r.endpoint;
  // faulty input from user can cause exception in handlebars
  try {
    let template = Handlebars.compile(linkUrl);
    linkUrl = template(g.context);
  }
  catch (e) {
        log.write(2, 'exception while applying URL template: ' + linkUrl);
        log.write(2, 'exception : ' + e );
  }
  var method = r.method || 'GET';
  // var payload = null;
  // if (method.toUpperCase() !== 'GET') {
  //   xxxx
  //   try {
  //     let pTemplate = Handlebars.compile(r.payload);
  //     payload = pTemplate(g.context);
  //   }
  //   catch (e) {
  //       log.write(2, 'exception while applying method template: ' + r.payload);
  //       log.write(2, 'exception : ' + e );
  //   }
  // }

  var headers = {};
  if (r.headers) {
    log.write(4, 'applying headers');
    Object.keys(r.headers).forEach(function(name){
      try {
        //log.write(7, 'header[%s]...', name);
        var nTemplate = Handlebars.compile(name, {noEscape:true});
        name = nTemplate(g.context);
        var value = r.headers[name];
        log.write(8, 'header[%s] raw value %s', name, value);
        var vTemplate = Handlebars.compile(value, {noEscape:true});
        //log.write(4, 'gContext %s', JSON.stringify(g.context));
        value = vTemplate(g.context);
        log.write(4, 'header[%s]= %s', name, value);
        headers[name] = value;
      }
      catch (e) {
        log.write(2, 'exception while applying header template: ' + r.headers[name]);
        log.write(2, 'exception : ' + e );
      }
    });
  }

  var p = Promise.resolve({});

  // initialize array of N + 1 promises
  var batchsize = Math.min(maxIterations, resolveExpression(r.iterations, 1));
  p = p.then( () => Promise.all( Array.apply(null, new Array(batchsize))
                                 .map((x, i) => invokeOneRequest(linkUrl, method, r.payload, headers, job))))
    .then( (results) =>
           new Promise(function(resolve, reject) {
             // perform extracts
             var lastResult = results[results.length - 1];
             if (r.extracts && Object.prototype.toString.call(r.extracts) === '[object Object]' && Object.keys(r.extracts).length>0) {
               log.write(2, 'extracts: ' + JSON.stringify(Object.keys(r.extracts)));
               Object.keys(r.extracts).forEach( resolveExtract(lastResult.body, lastResult.headers, lastResult.status, r.extracts) );
             }
             resolve({});
           }));
  return p;
}

function capitalizeOne(str) {
  return str.charAt(0).toUpperCase().concat(str.slice(1).toLowerCase());
}

function getVariationByDayOfWeek(currentDayOfWeek) {
  let dayName = dayNames[currentDayOfWeek % 7];

  function trySource(v) {
    var vtype = Object.prototype.toString.call(v);

    if (vtype === '[object Array]') {
      if (v.length &&
          v.length === 7 &&
          v[currentDayOfWeek] &&
          v[currentDayOfWeek] > 0 &&
          v[currentDayOfWeek] <= 10) {
        return v[currentDayOfWeek];
      }
      else {
        log.write(2, 'variationByDayOfWeek seems of wrong length, or value');
      }
    }
    else if (vtype === '[object Object]') {
      if (dayName) {
        return v[dayName] || v[capitalizeOne(dayName)];
      }
      else {
        log.write(2, 'variationByDayOfWeek seems wrong: ' + dayName);
      }
    }
    return undefined;
  }

  var v = trySource(g.model.variationByDayOfWeek) || trySource(defaults.variationByDayOfWeek) || 1;
  if ( ! (v > 0 && v <= 10)) {
    log.write(2, 'variationByDayOfWeek seems wrong: ' + dayName);
    v = 1;
  }
  log.write(5, 'day variation: ' + v);
  return v;
}

function getTargetRunsPerHour(now) {
  var currentHour = now.getHours();
  var currentMinute = now.getMinutes();
  var currentDayOfWeek = now.getDay();
  const speedfactor = 3.2;
  function getInvocationsPerHour(hour) {
    var r = (g.model.invocationsPerHour && g.model.invocationsPerHour[hour]);
    if ( ! r) {return defaults.invocationsPerHour[hour];}
    return r;
  }
  if (currentHour < 0 || currentHour > 23) { currentHour = 0;}
  var nextHour = (currentHour === 23) ? 0 : (currentHour + 1);

  // linear interpolation makes the 'by minute' graph smoother.
  var hourFraction = (currentMinute + 1) / 60;
  var b = getInvocationsPerHour(currentHour);
  var runsPerHour = speedfactor * (b + (hourFraction * (getInvocationsPerHour(nextHour) - b)));
  var v = getVariationByDayOfWeek(currentDayOfWeek);
  if (v) {
    runsPerHour = Math.floor(runsPerHour * v);
  }

  var gaussian = new Gaussian(runsPerHour, 0.1 * runsPerHour); // fuzz
  runsPerHour = Math.floor(gaussian.next());
  log.write(2, 'runsPerHour: %d', runsPerHour);
  return runsPerHour;
}

function getSleepTimeInMs(startOfMostRecentRequest) {
  var now = new Date(),
      runsPerHour = getTargetRunsPerHour(now),  // 0 <= x <= 59
      durationOfLastRun = now - startOfMostRecentRequest,
      sleepTimeInMs = Math.floor(oneHourInMs / runsPerHour) - durationOfLastRun;
  if (sleepTimeInMs < minSleepTimeInMs) { sleepTimeInMs = minSleepTimeInMs; }
  log.write(2, 'sleep ' + sleepTimeInMs + 'ms, wake at: ' +
            new Date(now.valueOf() + sleepTimeInMs).toString().substr(16, 8) );
  return sleepTimeInMs;
}

function setInitialContext(ctx) {
  g.status.runState = 'initializing';
  return { job: ctx };
}

function initializeJobRun(context) {
  g.status.jobId = context.job.id || '-none-';
  g.status.description = context.job.description || '-none-';

  // on initial startup, set loglevel and put it into the cache
  if (!context.continuing) {
    g.status.loglevel = context.job.initialLogLevel || context.job.loglevel || defaults.initialLogLevel;
    if (cache) {
      cache.put(cacheKey('loglevel'), '' + g.status.loglevel, 18640000, function(){});
    }
  }
  // put the run status into the cache.
  // (deploy implies start running)
  if (cache) {
    cache.put(cacheKey('status'), 'running', 8640000, function(){});
  }

  // launch the loop
  g.status.runState = 'running';
  return Promise.resolve(context)
    .then(invokeSequence)
    .catch(trackFailure);
}

function wakeup() {
  var wakeTime = new Date();
  log.write(2, 'awake');
  delete g.status.times.wake;
  delete g.status.sleepTimeInMs;

  function maybeRun() {
    log.write(2, 'runstate: ' + g.status.runState);
    if (g.status.runState === 'running') {
      Promise.resolve(g.model)
        .then(setInitialContext)
        .then(initializeJobRun)
        .catch(trackFailure);
    }
    else {
      g.status.nCycles++;
      g.status.times.lastRun = wakeTime.toISOString();
      let sleepTime = getSleepTimeInMs(wakeTime);
      //g.status.times.wake = (new Date((new Date()) + sleepTime)).toISOString();
      g.status.times.wake = (new Date((new Date()).valueOf() + sleepTime)).toISOString();
      setTimeout(wakeup, sleepTime);
    }
  }

  if ( ! cache) { maybeRun(); return; }

  cache.get(cacheKey('loglevel'), function(e, value) {
    if (e) {
      log.write(4, 'cannot retrieve loglevel. ' + e);
    }
    else {
      log.write(4, 'retrieved loglevel: ' + value);
    }
    if (e || typeof value === 'undefined'){
      value = defaults.initialLogLevel;
      log.write(4, 'using default loglevel: ' + value);
    }
    g.status.loglevel = Math.max(0, Math.min(10, parseInt(value, 10)));
    log.write(4, 'getting cached status');
    cache.get(cacheKey('status'), function(e, value) {
      var msg;
      if (e) {
        log.write(4, 'cannot retrieve status, presumed running.');
      }
      else {
        msg = (typeof value === 'undefined') ? 'undefined, ergo running.' : value;
        log.write(4, 'cached status: ' + msg);
      }
      g.status.cachedStatus = value || '-none-';
      if (value === 'stopped') { g.status.runState = 'stopped'; }
      maybeRun();
    });
  });
}

function invokeSequence(obj) {
  var sequenceStartTime = new Date();
  var job = obj.job;
  if ( ! job.hasOwnProperty('simulateGeoDistribution')) {
    job.simulateGeoDistribution = defaults.simulateGeoDistribution;
  }

  var startingCount = g.status.responseCounts.total;
  g.context = {...defaults.initialContext, ...job.initialContext };

  var p = Promise.resolve({});

  log.write(2, 'invokeSequence');

  // the batches of requests must be serialized
  job.requests.forEach(function(r, ix) {
    p = p.then(() => invokeOneBatchOfRequests(r, job));
  });

  p = p
    .then(function( /* ignoredResultValues */) {
      var now = new Date();
      var tps = (g.status.responseCounts.total - startingCount) / ((now - sequenceStartTime) / 1000);
      g.status.mostRecentSequenceTps = Math.round(Math.round(1000*tps)/10)/100;
      tps = g.status.responseCounts.total / ((now - new Date(g.status.times.start)) / 1000);
      g.status.netTps = Math.round(Math.round(1000*tps)/10)/100;
      g.status.nCycles++;
      g.status.times.lastRun = now.toISOString();
      let sleepTime = getSleepTimeInMs(sequenceStartTime);
      g.status.times.wake = (new Date(now.valueOf() + sleepTime)).toISOString();
      setTimeout(wakeup, sleepTime);
    });

  return p;
}


function reportModel (context) {
  console.log('================================================');
  console.log('==         Job Definition Retrieved           ==');
  console.log('================================================');
  console.log(JSON.stringify(context, null, 2));
  return context;
}

function kickoff(arg) {
  try {
    if ( ! fs.existsSync(arg)) {
      arg = defaultConfigFile;
    }
    if (fs.existsSync(arg)) {
      console.log(arg);
      g.model = JSON.parse(fs.readFileSync(arg, 'utf8'));
      g.status.statusCacheKey = cacheKey('status');
      g.status.loglevelCacheKey = cacheKey('loglevel');
      if (cache) {
        cache.put(g.status.statusCacheKey, 'starting', 8640000, function(e){});
      }

      if (fs.existsSync('config/defaults.json')) {
        defaults = JSON.parse(fs.readFileSync('config/defaults.json', 'utf8'));
      }

      Promise.resolve(g.model)
        .then(reportModel)
        .then(setInitialContext)
        .then(initializeJobRun)
        .catch(trackFailure);
    }
    else {
      console.log('That file does not exist. ('+arg+')');
    }
  }
  catch (exc1) {
    console.log('Exception:' + exc1);
    console.log(exc1.stack);
  }
}

// =======================================================
//
// The simple API exposed by this script allows POST /control
// and GET /status
//
// =======================================================

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function setGlobals(request) {
  ['org', 'env', 'proxy'].forEach(function(item) {
    var headerName = 'x-apigee-' + item;
    if (request.header(headerName)) {
      globals[item] = request.header(headerName);
    }
  });
}

app.get('/status', function(request, response) {
  var payload;
  setGlobals(request);
  response.header({'Content-Type': 'application/json'});
  if ( ! (g.model && g.model.id)) {
    response.status(200).send('{ "status" : "starting" }\n');
    return;
  }
  g.status.times.current = (new Date()).toISOString();
  payload = Object.assign({}, g.status);
  cache.get(cacheKey('status'), function(e, value) {
    if (e) {
      payload.error = true;
      payload.cacheException = e.toString();
      response.status(500)
        .send(JSON.stringify(payload, null, 2) + '\n');
    }
    else {
      payload.cachedStatus = value || '-none-';
      response.status(200)
        .send(JSON.stringify(payload, null, 2) + '\n');
    }
  });
});

app.post('/control', function(request, response) {
  setGlobals(request);
  if ( ! (g.model && g.model.id)) {
    response.status(503).send('{ "status" : "starting" }\n');
    return;
  }
  var payload,
      // post body parameter, or query param
      action = request.body.action || request.query.action,
      loglevel = request.body.loglevel || request.query.loglevel,
      putCallback = function(e) {
        cache.get(cacheKey('status'), function(e, value) {
          if (e) {
            payload.error = true;
            payload.cacheException = e.toString();
            response.status(500)
              .send(JSON.stringify(payload, null, 2) + '\n');
          }
          else {
            payload.cachedStatus = value;
            response.status(200)
              .send(JSON.stringify(payload, null, 2) + '\n');
          }
        });
      };

  response.header({'Content-Type': 'application/json'});
  payload =  Object.assign({}, g.status);
  payload.times.current = (new Date()).toString();

  if (action !== 'stop' && action !== 'start' && action !== 'setlog') {
    payload.error = 'unsupported request (action)';
    response.status(400).send(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  if (action === 'setlog') {

    if (!isNumber(loglevel)) {
      payload.error = 'must pass loglevel';
      response.status(400)
        .send(JSON.stringify(payload, null, 2) + '\n');
      return;
    }
    // coerce
    loglevel = Math.max(0, Math.min(10, parseInt(loglevel, 10)));
    cache.put(cacheKey('loglevel'), '' + loglevel, 18640000, function(e) {
      if (e) {
        payload.error = true;
        payload.cacheException = e.toString();
        response.status(500)
          .send(JSON.stringify(payload, null, 2) + '\n');
      }
      else {
        payload.loglevel = loglevel;
        response.status(200)
          .send(JSON.stringify(payload, null, 2) + '\n');
      }
    });
  }
  else {
    cache.get(cacheKey('status'), function(e, value) {
      if (e) {
        payload.error = true;
        payload.cacheFail = true;
        payload.cacheException =  e.toString();
        response.status(500).send(JSON.stringify(payload, null, 2) + '\n');
      }
      else {
        payload.cachedStatus = value;
        if (value === 'stopped') {
          if (action === 'stop') {
            // nothing to do...send a 400.
            payload.error = 'already stopped';
            response.status(400).send(JSON.stringify(payload, null, 2) + '\n');
          }
          else {
            // action == start
            cache.put(cacheKey('status'), 'running', 8640000, putCallback);
          }
        }
        else {
          // is marked 'running' now.
          if (action === 'stop') {
            cache.put(cacheKey('status'), 'stopped', 8640000, putCallback);
          }
          else {
            // action == start
            // nothing to do, send a 400.
            payload.error = 'already running';
            response.status(400).send(JSON.stringify(payload, null, 2) + '\n');
          }
        }
      }
    });
  }
});

// default behavior
app.all(/^\/.*/, function(request, response) {
  response.header({'Content-Type': 'application/json'})
    .status(404)
    .send('{ "message" : "This is not the server you\'re looking for." }\n');
});

var positionalArgs = process.argv.slice(2);
var modelFilename = positionalArgs[0] || defaultConfigFile;
var port = process.env.PORT || 5950;
app.listen(port, function() {
  try {
    // try to use cache IPC between the instances
    var apigee = require('apigee-access'); // may throw
    cache = apigee.getCache(undefined, { scope: 'application' }); // get the default cache
  }
  catch(e) {}
  setTimeout(function() { return kickoff(modelFilename); }, 600);
});
