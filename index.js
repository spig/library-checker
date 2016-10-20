'use strict';

var request = require('request');
var cheerio = require('cheerio');
var waterfall = require('async-waterfall');
var async = require('async');
//var config = require('./config');

var filename = process.argv[2];
var pin = process.argv[3];

var DUE_WARNING_DAYS = 2;

/*
function getModel () {
  return require('./model-' + config.get('DATA_BACKEND'));
}
*/

var itemModel = require('./item-model-datastore');//getModel();
var holdsModel = require('./holds-model-datastore');

var virtualRegex = /virtual/i;

Date.prototype.addDays = function(days) {
    var date = new Date(this.valueOf());
    date.setDate(date.getDate() + days);
    return date;
};

function bookIsDue(dueDate) {
    try {
        var due = Date.parse(dueDate);
        var today = (new Date()).setHours(0,0,0,0);// set to beginning of today
        console.log('is book due: ', (new Date(due - today)).getDate() <= DUE_WARNING_DAYS);
        return (new Date(due - today)).getDate() <= DUE_WARNING_DAYS;
    } catch (ex) {
        console.log(ex);
        return true;
    }
}

/* true if the library is the 'virtual' library */
function itemIsElectronic(item) {
    if (item.library) {
        console.log('item has library and is electronic', item.library.search(virtualRegex) !== -1);
        return item.library.search(virtualRegex) !== -1;
    } else {
        console.log('item has NO library', item);
        return false;
    }
}


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
        var patronItems = [];
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
                    function () { // (err, httpResponse, body) {
                        // TODO log httpResponse, body?
                        cb(null);
                    }
                );
            },
            function(cb) {
                request.get(
                    {
                        url: 'https://catalog.slcolibrary.org/polaris/patronaccount/requests.aspx',
                        jar: jar
                    },
                    function(err, httpResponse, body) {
                        cb(null, body);
                    }
                );
            },
            function(patronHolds, cb) {
                var $ = cheerio.load(patronHolds);
                var items = $('#GridView1').find($('tr.patrongrid-row'));
                items.each(function() {
                    var holdItem = {};
                    $(this).find($('span[id^="GridView"]')).each(function() {
                        holdItem[getStandardKey($(this).attr('id'))] = $(this).text();
                    });
                    $(this).find($('a.requestdetailview')).each(function() {//(idx, a) {
                        holdItem.reqID = $(this).attr('href').split('ReqID=')[1].match(/\d+/)[0];
                    });
                    // add library card number to holdItem
                    holdItem.patronCardNumber = cardNumber;
                    holdItem.hold = true;
                    patronItems.push(holdItem);
                });
                cb(null);
            },
            function(cb) {
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
            function(patronItemPage, cb) {
                var $ = cheerio.load(patronItemPage);
                var items = $('#GridView1').find($('tr.patrongrid-row'));
                items.each(function() {
                    var coItem = {};
                    $(this).find($('span[id^="GridView"]')).each(function() {
                        coItem[getStandardKey($(this).attr('id'))] = $(this).text();
                    });
                    $(this).find($('a.itemdetailview')).each(function() { // (idx, a) {
                        coItem.recID = $(this).attr('href').split('RecID=')[1].match(/\d+/)[0];
                    });
                    // add library card number to coItem
                    coItem.patronCardNumber = cardNumber;
                    patronItems.push(coItem);
                });
                cb(null);
            }
        ], function(err) {
            if (err) {
                return callback(err);
            }

            callback(null, patronItems);
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

            .map(function(item) {
                // TODO: add the card number to the data logged
                if (item.due) {
                    itemModel.create({
                            'recID': item.recID,
                            'title': item.title,
                            'dueDate': Date.parse(item.due),
                            'isDue': bookIsDue(item.due) && ! itemIsElectronic(item),
                            'library': item.library,
                            'card': item.patronCardNumber,
                            'created': new Date()
                        },
                        function(err, savedData) {
                            if (err) {
                                console.log('err: ' + err);
                            }

                            console.log('savedData: ' + JSON.stringify(savedData));
                        }
                    );
                }

                if (item.hold) {
                    holdsModel.create({
                            'reqID': item.reqID,
                            'title': item.title,
                            /*
                            'dueDate': Date.parse(item.due),
                            'isDue': bookIsDue(item.due),
                            */
                            'card': item.patronCardNumber,
                            'created': new Date()
                        },
                        function(err, savedData) {
                            if (err) {
                                console.log('err: ' + err);
                            }

                            console.log('savedData: ' + JSON.stringify(savedData));
                        }
                    );
                }

                return item;
            })

            // remove items that are from Virtual Library - can't be late
            .filter(function (item) {
                if (item.library) {
                    return item.library.search(/virtual/i) === -1;
                }

                // else keep this item
                return true;
            })

            // only show those items that are due
            .filter(function (item) {
                return bookIsDue(item.due);
            })

            // print matching items
            .map(function(item) {
                console.log(item.title + ' is due ' + item.due);
            });

            // TODO: filter out items that are due
            // TODO: idea - log all items checked out to a database, write another script to query database for those that are coming due, write another script to do auto-renewals
            // TODO: script to check for items that are available
        }
    );
});
