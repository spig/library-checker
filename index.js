'use strict';

var request = require('request');
var cheerio = require('cheerio');
var waterfall = require('async-waterfall');
var async = require('async');

var filename = process.argv[2];
var pin = process.argv[3];

function getStandardKey(key) {
    if (key.search(/branch/i) !== -1) { return 'library'; }
    else if (key.search(/callnumber/i) !== -1) { return 'callnumber'; }
    else if (key.search(/title/i) !== -1) { return 'title'; }
    else if (key.search(/due/i) !== -1) { return 'due'; }
    else if (key.search(/renewals/i) !== -1) { return 'renewals'; }
    else { return key; }
}

function checkCard(cardNumber) {
    return function(callback) {
        var jar = request.jar();
        waterfall([
            function(cb) {
                request.get(
                    {
                        url:'https://catalog.slcolibrary.org/polaris/logon.aspx',
                        jar: jar
                    },
                    function (err, httpResponse, body) {
                        cb(null, body);
                    }
                );
            },
            function(loginPage, cb) {
                var formData = {
                  // Pass a simple key-value pair
                  textboxBarcodeUsername: cardNumber,
                  textboxPassword: pin,
                  buttonSubmit: 'Log In'
                };

                var $ = cheerio.load(loginPage);
                $('#formMain input[type="hidden"]').each(function() {
                    formData[$(this).attr('name')] = $(this).val();
                });
                request.post(
                    {
                        url:'https://catalog.slcolibrary.org/polaris/logon.aspx',
                        formData: formData,
                        jar: jar,
                        followAllRedirects: true
                    },
                    function (err, httpResponse, body) {
                        cb(null, body);
                    }
                );
            },
            function(userPage, cb) {
                request.get(
                    {
                        url: 'https://catalog.slcolibrary.org/polaris/patronaccount/itemsout.aspx',
                        jar: jar
                    },
                    function (err, httpResponse, body) {
                        cb(null, body);
                    }
                );
            },
            function(patronItems, cb) {
                var $ = cheerio.load(patronItems);
                var items = $('#GridView1').find($('tr.patrongrid-row'));
                var checkedOutItems = [];
                items.each(function() {
                    var coItem = {};
                    $(this).find($('span[id^="GridView"]')).each(function() {
                        coItem[getStandardKey($(this).attr('id'))] = $(this).text();
                    });
                    checkedOutItems.push(coItem);
                });
                cb(null, checkedOutItems);
            }
        ], function(err, result) {
            if (err) {
                return callback(err);
            }

            callback(null, result);
        });
    };
}

var lineReader = require('readline').createInterface({
      input: require('fs').createReadStream(filename)
});

var cardCheckFunctions = [];
lineReader.on('line', function (line) {
    console.log('checking librarycard number: ', line);
    cardCheckFunctions.push(checkCard(line));
});

lineReader.on('close', function() {
    async.parallel(
        cardCheckFunctions,
        function(err, results) {
            if (err) {
                return console.log('error: ' + err);
            }

            // flatten array of results
            [].concat.apply([], results)

            // remove items that are from Virtual Library - can't be late
            .filter(function (item) {
                if (item.library) {
                    return item.library.search(/virtual/i) === -1;
                }

                // else keep this item
                return true;
            })

            // print matching items
            .map(function(item) {
                console.log(item);
            });

            // TODO: filter out items that are due
            // TODO: idea - log all items checked out to a database, write another script to query database for those that are coming due, write another script to do auto-renewals
            // TODO: script to check for items that are available
        }
    );
});
