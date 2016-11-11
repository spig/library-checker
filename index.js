'use strict';

var request = require('request');
var cheerio = require('cheerio');
var waterfall = require('async-waterfall');
var async = require('async');
//var config = require('./config');

var filename = process.argv[2];
var pin = process.argv[3];

var DUE_WARNING_DAYS = 2;

var model = require('./model-datastore');

var virtualRegex = /(virtual|online)/i;

var today = (new Date()).setHours(0,0,0,0);// set to beginning of today

Date.prototype.addDays = function(days) {
    var date = new Date(this.valueOf());
    date.setDate(date.getDate() + Number.parseInt(days, 10));
    return new Date(date.setHours(0,0,0,0));
};

function bookIsDue(dueDate) {
    try {
        var due = Date.parse(dueDate);
        return (new Date(due - today)).getDate() <= DUE_WARNING_DAYS;
    } catch (ex) {
        console.log(ex);
        return true;
    }
}

/* true if the library is the 'virtual' library */
function itemIsElectronic(item) {
    if (item.library) {
        return item.library.search(virtualRegex) !== -1;
    } else {
        return false;
    }
}


function getStandardKey(key) {
    if (key.search(/(branch|library)/i) !== -1) { return 'library'; }
    else if (key.search(/title/i) !== -1) { return 'title'; }
    else if (key.search(/due|holdsdate/i) !== -1) { return 'recordDate'; }
    else if (key.search(/renewals|position/i) !== -1) { return 'renewalsOrPosition'; }
    else if (key.search(/callnumber|author/i) !== -1) { return 'callnumberAuthor'; }
    else if (key.search(/holds(active|held|misc|pendingshipped)/i) !== -1) { return 'holdstatus'; }
    else { return key.toLocaleLowerCase(); }
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
                        url: 'https://catalog.slcolibrary.org/polaris/patronaccount/components/ajaxPatronDataCloudLibrary3M.aspx?SetLoaded=true',
                        jar: jar
                    },
                    function() { //err, httpResponse, body) {
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
                // TODO - determine date the hold expires
                // have seen - 'until today', 'yesterday', '2 days ago', 'since 9/10/2016', 'on 10/15/2016'
                var $ = cheerio.load(patronHolds);
                var items = $('#GridView1').find($('tr[class*=patrongrid-]'));
                items.each(function() {
                    var holdItem = {};
                    $(this).find($('span[id^=GridView]')).each(function() {
                        holdItem[getStandardKey($(this).attr('id'))] = $(this).text();
                    });
                    $(this).find($('a.requestdetailview')).each(function() {//(idx, a) {
                        var href = $(this).attr('href');
                        if (href) {
                            var qs = href.split('?');
                            if (qs[1]) {
                                qs[1].split('&').forEach(function(kv) {
                                    var keyval = kv.split('=');
                                    if (keyval[0].search(/(obj|req)id/i) !== -1) {
                                        holdItem.recordID = keyval[1];
                                    }
                                });
                            }
                        }
                    });
                    $(this).find($('span[class*=Holds]')).each(function() {
                        holdItem[getStandardKey($(this).attr('class'))] = $(this).text();
                    });
                    holdItem.type = 'hold';
                    holdItem.cardNumber = cardNumber;
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
                var items = $('#GridView1').find($('tr[class*=patrongrid-]'));
                items.each(function() {
                    var coItem = {};
                    $(this).find($('span[id^="GridView"]')).each(function() {
                        coItem[getStandardKey($(this).attr('id'))] = $(this).text();
                    });
                    $(this).find($('a.itemdetailview')).each(function() { // (idx, a) {
                        coItem.recordID = $(this).attr('href').split('RecID=')[1].match(/\d+/)[0];
                    });
                    // add library card number to coItem
                    coItem.type = 'checkout';
                    coItem.cardNumber = cardNumber;
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

function parseRecordDate(recordDate) {
    var daysMatch = recordDate.match(/\d+/);
    if (recordDate.search(/since|on|as of/i) !== -1) {
        var dateMatch = recordDate.match(/\d+\/\d+\/\d+/);
        if (dateMatch.length > 0) {
            return new Date(Date.parse(dateMatch[0]));
        } else {
            return new Date();
        }
    }
    if (recordDate.search(/days ago/i) !== -1) {
        if (daysMatch.length > 0) {
            return (new Date()).addDays(-1 * daysMatch[0]);
        } else {
            return new Date();
        }
    }
    if (recordDate.search(/more days/i) !== -1) {
        // TODO - return the number left
        if (daysMatch.length > 0) {
            return (new Date()).addDays(daysMatch[0]);
        } else {
            return new Date();
        }
    }
    if (recordDate.search(/yesterday/i) !== -1) {
        return (new Date()).addDays(-1);
    }
    if (recordDate.search(/today/i) !== -1) {
        return new Date();
    }
    if (recordDate.search(/tomorrow/i) !== -1) {
        return (new Date()).addDays(1);  // today + 1 day = tomorrow
    }
    if (recordDate.search(/^\d+\/\d+\/\d+$/) === -1) {
        console.log('unhandled recordDate value: ' + recordDate);
        // attempt to handle as a day value
        if (daysMatch && daysMatch.length > 0) {
            return (new Date()).addDays(daysMatch[0]);
        } else {
            return new Date();
        }
    }

    var parsedDate = Date.parse(recordDate);
    if (Number.isNaN(parsedDate)) {
        return new Date();
    } else {
        return new Date(Date.parse(recordDate));
    }
}

function itemCheckFunctions(items) {
    return items.map(
        function(item) {
            if (item.holdstatus && item.holdstatus.search(/cancelled/i) !== -1) {
                return;
            }

           return function(callback) {
               // remove holdstatus
               delete item.holdstatus;

               item.created = new Date();
               item.isElectronic = itemIsElectronic(item);

               item.recordDate = parseRecordDate(item.recordDate);

               // TODO - drop isDue when we have the system in place to check items based on a users preferences
               if (item.type === 'hold') {
                   item.isDue = today < item.recordDate;
               } else if (item.type === 'checkout') {
                   item.isDue = bookIsDue(item.due) && ! itemIsElectronic(item);
               }
               // TODO - get all existing items and only update those that have changed
               // TODO - remove all items that no longer exist on patron record
               // TODO - query the dataset for all items given a card number,
               // filter those that match recordID, cardNumber and recordDate,
               // removing everything else for that card number,
               // add those that are missing
               // leaving the rest in place to avoid writing the same data
               // query items by recordID, recordDate);


               // see if this item already exists in the datastore
               model.getItem(item.recordID, item.recordDate, function(err, dbItems) {
                   if (err) { return console.log('error: ' + err); }

                   var dbItem = dbItems[0];
                   //dbItemsFound.push(dbItem);

                   if (dbItems.length > 0) {
                       if (dbItems.length === 1 && item.recordDate.valueOf() !== dbItem.recordDate.valueOf()) {
                           console.log('item has new recordDate', item.recordDate.valueOf(), dbItem.recordDate.valueOf());
                           //console.log(JSON.stringify(dbItem));
                           // update item
                           // set the item id to the dbItem's id
                           item.id = dbItem.id;
                           model.update (dbItem.id, item, function(err, savedData) {
                               if (err) {
                                   return callback(err);
                               }
                               console.log('savedData:', savedData);
                           });
                       } else {
                           console.log('item exists and is unchanged - skipping insert', item.type);
                       }
                   } else {
                       console.log('saving data...');
                       model.create(
                           item,
                           function(err, savedData) {
                               if (err) {
                                   return callback(err);
                               }

                               //console.log('savedData: ' + JSON.stringify(savedData));
                           }
                       );
                   }
                   callback(null, item);
               }); // end model.getItem
           };
        });
}

lineReader.on('close', function() {
    // TODO - find a way to delete items we didn't see during this check of the library cards
    // maybe wrap this in a waterfall so once we retrieve all items
    // checked out, we then see which ones are no longer in the database
    // and remove them
//    var dbItemsFound = [];
    waterfall(
        [
            function (cb) {
                async.parallel(
                    cardCheckFunctions,
                    function (err, results) {
                        if (err) {
                            return console.log('error: ' + err);
                        }

                        // flatten array of results
                        results = [].concat.apply([], results);

                        async.parallel(
                            itemCheckFunctions(results),
                            function (err, results) {
                                if (err) { return cb(err); }

                                console.log('done with itemCheckFunctions');
                                return cb(null);
                            }
                        );
                    }
                );
            }
        ], function (err) {
            if (err) {
                console.log(err);
            } else {
                console.log('library check complete');
            }
        }
    );
});

        /*
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
            */

            // TODO: filter out items that are due
            // TODO: idea - log all items checked out to a database, write another script to query database for those that are coming due, write another script to do auto-renewals
            // TODO: script to check for items that are available
