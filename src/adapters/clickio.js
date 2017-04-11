const bidfactory = require('../bidfactory.js');
const bidmanager = require('../bidmanager.js');
const adloader   = require('../adloader');
const CONSTANTS  = require('../constants.json');
const utils      = require('../utils.js');

const AmnhbAdapter = function AmnhbAdapter() {
    const BIDDER_CODE        = 'clickio';
    let instanceCallbackName = BIDDER_CODE+utils.getUniqueIdentifierStr();

    let console = window['console'];

    // utils.logWarn
    // utils.logInfo
    // utils.logMessage
    // utils.logError

    // utils.createInvisibleIframe

    $$PREBID_GLOBAL$$[instanceCallbackName] = function (response) {
        console.groupCollapsed('Clickio HB response');
        console.log(response);
        console.groupEnd();

        let adUnits = response.ads || [];

        if (!adUnits) {
            adUnits = [];
        }

        let bids = $$PREBID_GLOBAL$$._bidsRequested.find(bidSet => bidSet.bidderCode === BIDDER_CODE).bids;

        for (let i = 0; i < bids.length; i++) {
            let bid      = bids[i];
            let adUnitId = null;
            let adUnit   = null;

            // find the adunit in the response
            for (let j = 0; j < adUnits.length; j++) {
                adUnit = adUnits[j];
                if (String(bid.params.unit) === String(adUnit.adunitid)
                    && adUnitHasValidSizeFromBid(adUnit, bid) && !adUnit.used
                ) {
                    adUnitId = adUnit.adunitid;
                    break;
                }
            }

            let beaconParams = {
                bd: +(new Date())-startTime,
                br: '0', // maybe 0, t, or p
                bt: $$PREBID_GLOBAL$$.cbTimeout || $$PREBID_GLOBAL$$.bidderTimeout, // For the timeout per bid request
                bs: window.location.hostname
            };

            // no fill :(
            if (!adUnitId || !adUnit.pub_rev) {
                addBidResponse(null, bid);
                continue;
            }
            adUnit.used = true;

            beaconParams.br = beaconParams.bt < beaconParams.bd ? 't' : 'p';
            beaconParams.bp = adUnit.pub_rev;
            beaconParams.ts = adUnit.ts;
            addBidResponse(adUnit, bid);
            buildBoPixel(adUnit.creative[0], beaconParams);
        }
    };

    function addBidResponse(adUnit, bid) {
        let bidResponse        = bidfactory.createBid(adUnit ? CONSTANTS.STATUS.GOOD : CONSTANTS.STATUS.NO_BID, bid);
        bidResponse.bidderCode = BIDDER_CODE;

        if (adUnit) {
            let creative      = adUnit.creative[0];
            bidResponse.ad    = adUnit.html;
            bidResponse.cpm   = Number(adUnit.pub_rev)/1000;
            bidResponse.ad_id = adUnit.adid;
            if (adUnit.deal_id) {
                bidResponse.dealId = adUnit.deal_id;
            }
            if (creative) {
                bidResponse.width  = creative.width;
                bidResponse.height = creative.height;
            }
        }
        bidmanager.addBidResponse(bid.placementCode, bidResponse);
    }

    function exists(variable) {
        return typeof(variable) != 'undefined';
    }

    function buildQueryStringFromParams(params) {
        for (let key in params) {
            if (params.hasOwnProperty(key)) {
                if (!params[key]) {
                    delete params[key];
                } else {
                    params[key] = encodeURIComponent(params[key]);
                }
            }
        }

        return utils._map(Object.keys(params), key => `${key}=${params[key]}`).join('&');
    }

    function adUnitHasValidSizeFromBid(adUnit, bid) {
        let sizes         = utils.parseSizesInput(bid.sizes);
        let sizeLength    = sizes && sizes.length || 0;
        let found         = false;
        let creative      = adUnit.creative && adUnit.creative[0];
        let creative_size = String(creative.width)+'x'+String(creative.height);

        if (utils.isArray(sizes)) {
            for (let i = 0; i < sizeLength; i++) {
                let size = sizes[i];
                if (String(size) === String(creative_size)) {
                    found = true;
                    break;
                }
            }
        }

        return found;
    }

    function buildRequest(bids, params, biddingDomain) {
        if (!utils.isArray(bids)) {
            return;
        }

        params['ids'] = utils._map(bids, bid => bid['params']['sds_id']).join(',');
        params['szs'] = utils._map(bids, bid => {return utils.parseSizesInput(bid.sizes).join(',');}).join('|');

        /*bids.forEach(function (bid) {
            for (let customParam in bid.params.customParams) {
                if (bid.params.customParams.hasOwnProperty(customParam)) {
                    params["c."+customParam] = bid.params.customParams[customParam];
                }
            }
        });*/

        let requestUrl = `//${biddingDomain}/hb.php?${buildQueryStringFromParams(params)}`;

        console.groupCollapsed('Clickio HB request url');
        console.log(requestUrl);
        console.groupEnd();

        adloader.loadScript(requestUrl);
    }

    function callBids(bidsObj) {
        let isIfr,
            bids = bidsObj.bids || [];

        console.groupCollapsed('Clickio HB request');
        console.log(bidsObj);
        console.groupEnd();

        /*try {
            isIfr = window.self !== window.top;
        } catch (e) {
            isIfr = false;
        }*/

        if (bids.length === 0) {
            return;
        }

        let currentURL = (window.parent !== window) ? document.referrer : window.location.href;
        currentURL     = currentURL && encodeURIComponent(currentURL);

        let biddingDomain = bids[0].params.bidsDomain;

        let params = {
            'rt': utils.getUniqueIdentifierStr(),
            'r':  currentURL,
            'f':  `$$PREBID_GLOBAL$$.${instanceCallbackName}`
        };

        if (window.parent === window
            && document.getElementsByTagName("title").length
        ) {
            params["title"] = document.getElementsByTagName("title")[0].innerHTML.trim().substring(0, 256);
        }

        if ('https:' == window.location.protocol) {
            params["https"] = 1;
        }

        if (exists(screen.width)) {
            params["scr"] = screen.width+'x'+screen.height;
        }

        if (exists(window.innerWidth)) {
            params["wnd"] = window.innerWidth+'x'+window.innerHeight;
        }

        buildRequest(bids, params, biddingDomain);
    }

    return {
        callBids: callBids
    };
};

module.exports = AmnhbAdapter;
