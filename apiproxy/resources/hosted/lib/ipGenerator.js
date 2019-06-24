// selectIp.js
// ------------------------------------------------------------------
/* jshint esversion: 8, node: true */
/* global console */

'use strict';

const fs = require('fs'),
      path = require('path'),
      WeightedRandomSelector = require('./weightedRandomSelector.js');

function getCountrySelector(){
  var pop = require('./data/population2016.json'),
      countryAdjustments = require('./data/population_weight_adjustments.json'),
      countries = pop.records.map( elt =>[ elt, Number(elt.value * (countryAdjustments[elt.name] || 1)) ]);
  return new WeightedRandomSelector(countries);
}

function readZone(zoneName) {
  return fs.readFileSync(path.resolve(__dirname, './data/zones/' + zoneName.toLowerCase() + '.zone'), 'utf-8')
    .split(/\n/)
    .filter( line => line && line.trim() !== '' )
    .map( line =>
          [line, Math.pow(2, 32 - Number(line.split(/\//, 2)[1]))]
        );
}

function randomIpFromCidr(cidr) {
  var [ network, mask ] = cidr.split(/\//, 2),
      parsedNetwork = network.split( /\./ ),
      mapped = parsedNetwork.map( n => ('00' + parseInt(n, 10).toString(16)).substr(-2) ),
      networkAsHex = parseInt(mapped.join(''), 16),
      hostMax = Math.pow(2, 32 - mask),
      chosenHost = Math.floor(Math.random() * hostMax),
      finalHostAsHex = ('00' + (networkAsHex + chosenHost).toString(16)).substr(-8),
      groups = [];
  for (var i = 0; i < 8; i += 2) {
    groups.push(parseInt(finalHostAsHex.slice(i, i + 2), 16));
  }
  return groups.join('.'); // eg, 192.168.1.176
}

const countrySelector = getCountrySelector();

function generateIp() {
  var country;
  do {
    country = countrySelector.select()[0];
  } while ( ! country.zone);

  //console.log('selected country: %s', country.name);

  var blockSelector = new WeightedRandomSelector(readZone(country.zone));
  var selectedBlock = blockSelector.select()[0];
  //console.log('selected block  : %s', selectedBlock);

  var ip = randomIpFromCidr(selectedBlock);
  //console.log('random IP       : %s', ip);
  return {ip, country: country.name, block:selectedBlock};
}

module.exports = {
  generateIp
};
