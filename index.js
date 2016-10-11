'use strict';

var request = require('request');
var cheerio = require('cheerio');
var waterfall = require('async-waterfall');
var async = require('async');

var filename = process.argv[2];
var pin = process.argv[3];

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
                        //console.log(httpResponse);
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
                        coItem[$(this).attr('id')] = $(this).text();
                    });
                    checkedOutItems.push(coItem);
                    //GridView1_labelTitle_0
                });
        //        console.log('items out: ' + $('#GridView1').find($('tr.patrongrid-row')).length);
         //       $('#GridView1').each(function(index, element) {
        //            console.log($(this).html());
        //        });
                cb(null, checkedOutItems);
            }
        ], function(err, result) {
            if (err) {
                callback(err);
            }

            callback(null, result);
        });
    };
}

var lineReader = require('readline').createInterface({
      input: require('fs').createReadStream(filename)
});

lineReader.on('line', function (line) {
    console.log('checking librarycard number: ', line);
    async.parallel([
        checkCard(line)
    ], function(err, results) {
        if (err) {
            return console.log('error: ' + err);
        }

        console.log(results);
    });
});
