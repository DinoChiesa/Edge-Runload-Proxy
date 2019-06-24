the runload-server.js module will run a set of REST requests from Node, as
specified in a job definition file. This is to generate load for APIs (probably Proxies).

This script uses various npm modules. You may need to do the
following to get pre-requisites before running this script:

  npm install

There is an API for this target.


GET /status
  returns a json payload providing status of the service.
  Keep in mind the status is for the nodejs logic on a single MP only.
  There are typically multiple MPs, so invoking GET /status multiple
  times in succession will likely deliver different responses. A response
  looks like this:

  {
    "version": "20180111-0814",
    "times": {
      "start": "Fri Feb 13 2015 02:58:10 GMT-0000 (UTC)",
      "lastRun": "Fri Feb 13 2015 03:07:28 GMT-0000 (UTC)",
      "wake": "Fri Feb 13 2015 03:08:38 GMT-0000 (UTC)",
      "current": "Fri Feb 13 2015 03:08:06 GMT-0000 (UTC)"
    },
    "loglevel": 2,
    "nRequests": 42,
    "jobId": "hnacino-azure-job1",
    "description": "drive Henry's Azure-hosted APIs",
    "status": "waiting",
    "responseCounts": {
      "total": 42,
      "200": 41,
      "401": 1
    },
    "statusCacheKey": "runload-status-hnacino-azure-job1",
    "loglevelCacheKey": "runload-loglevel-hnacino-azure-job1",
    "nCycles": null,
    "durationOfLastRunInMs": 1632,
    "currentRunsPerHour": 51,
    "cachedStatus": "-none-"
  }

POST /control
  pass a x-www-form-urlencoded payload . eg, Use this header:
       Content-type:application/x-www-form-urlencoded

  Option 1: start or stop the calls being emitted from the nodejs script.
  use params like this:
    action=start
  or
    action=stop

  You need to send this request just once, to stop all MPs
  that are generating load.

  Option 2: set the log level. use form params like this:
     action=setlog&loglevel=N

  where N = [0,10]
    0 = almost no logging
    2 = very minimal logging - only wake/sleep and errors
    3 = see each API call out.
     progressively more info
   10 = max logging

------------------------------------------------------------------

