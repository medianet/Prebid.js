const bidfactory = require('src/bidfactory.js');
const bidmanager = require('src/bidmanager.js');
const adloader = require('src/adloader');
const CONSTANTS = require('src/constants.json');
const utils = require('src/utils.js');

var ClickioAdapter = function ClickioAdapter() {
  const BIDDER_CODE = 'clickio';
  const prebidInstance = $$PREBID_GLOBAL$$;

  let idsCounters = {};

  let generateResponseCallback = function (instanceCalbackName, bids) {
    return function (response) {
      utils.logInfo(BIDDER_CODE + ' server response:\n' + JSON.stringify(response, null, 4));

      let adUnits = response.filter(responseItem => responseItem.id);

      if (!adUnits.length && response.length) {
        utils.logInfo(BIDDER_CODE + ' no bids returned');
      } else {
        utils.logInfo(BIDDER_CODE + '\nbids returned:\n' + JSON.stringify(adUnits, null, 4));
      }

      for (let i = 0; i < bids.length; i++) {
        let bid = bids[i];
        let adUnit = null;

        adUnit = adUnits.find(adUnit => adUnit.id == bid.params.fullSiteAreaId && !exists(adUnit.used));

        if (!adUnit || !adUnit.cpm || !adUnit.ad) {
          addBidResponse(null, bid);
          continue;
        }

        adUnit.used = true;

        addBidResponse(adUnit, bid);
      }

      delete prebidInstance[instanceCalbackName];

      return true;
    }
  };

  function addBidResponse(adUnit, bid) {
    let bidResponse = bidfactory.createBid(adUnit ? CONSTANTS.STATUS.GOOD : CONSTANTS.STATUS.NO_BID, bid);
    bidResponse.bidderCode = BIDDER_CODE;

    if (adUnit) {
      bidResponse.siteAreaId = adUnit.id;
      bidResponse.fullSiteAreaId = bid.params.fullSiteAreaId;
      bidResponse.ad = adUnit.ad;
      bidResponse.cpm = Number(adUnit.cpm);
      bidResponse.width = Number(adUnit.width);
      bidResponse.height = Number(adUnit.height);
    }

    bidmanager.addBidResponse(bid.placementCode, bidResponse);
  }

  function exists(variable) {
    return typeof (variable) !== 'undefined';
  }

  function attempt(valueFunction, defaultValue) {
    defaultValue = defaultValue || null;

    try {
      return valueFunction();
    } catch (ex) {
    }

    return defaultValue;
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

  function _callBids(bidsObj) {
    let bids = bidsObj.bids || [];

    if (!utils.isArray(bids)) {
      return;
    }

    utils.logInfo(BIDDER_CODE + ' adapter invoking');
    utils.logInfo(BIDDER_CODE + '\nbids config:\n' + JSON.stringify(bids, null, 4));

    if (bids.length === 0) {
      utils.logWarn(BIDDER_CODE + ' adapter invoking without bids');
      return;
    }

    let ids = utils._map(bids, function (bid) {
      let areaId = bid.params.siteAreaId;

      if (!areaId) {
        return;
      }

      if (!exists(idsCounters[areaId])) {
        idsCounters[areaId] = 1;
      } else {
        idsCounters[areaId]++;
      }

      let fullAreaId = areaId + (idsCounters[areaId] > 1 ? `.${idsCounters[areaId]}` : '');
      bid.params.fullSiteAreaId = fullAreaId;
      return fullAreaId;
    }).filter(id => id).join(';');

    if (!ids) {
      utils.logError('Could not find siteAreaIds', BIDDER_CODE);
      return;
    }

    let biddingDomain = bids[0].params.bidsDomain;
    if (!biddingDomain) {
      utils.logError('No bidding domain specified', BIDDER_CODE);
      return;
    }

    let instanceId = utils.getUniqueIdentifierStr();
    let instanceCalbackName = BIDDER_CODE + instanceId;

    let params = {
      rt: instanceId,
      f: `$$PREBID_GLOBAL$$.${instanceCalbackName}`,
      szs: utils._map(bids, bid => {
        return utils.parseSizesInput(bid.sizes).join(',');
      }).join(';')
    };

    let title = attempt(function () {
      return window.top.document.getElementsByTagName('title')[0].innerHTML.trim().substring(0, 256);
    });
    if (title) {
      params.title = title;
    }

    let winLoc = utils.getTopWindowLocation();

    let currentURL = attempt(function () {
      return window.top !== window ? document.referrer : winLoc.href;
    }, document.referrer);
    if (currentURL) {
      params.r = currentURL;
    }

    if (winLoc.protocol === 'https:') {
      params.https = 1;
    }

    if (exists(screen.width)) {
      params.scr = screen.width + 'x' + screen.height;
    }

    if (exists(window.innerWidth)) {
      params.wnd = window.innerWidth + 'x' + window.innerHeight;
    }

    let requestUrl = `//${biddingDomain}/hb/${ids}/?${buildQueryStringFromParams(params)}`;

    utils.logInfo(BIDDER_CODE + ' request url:\n' + requestUrl);

    prebidInstance[instanceCalbackName] = generateResponseCallback(instanceCalbackName, bids);

    adloader.loadScript(requestUrl);

    return true;
  }

  return {
    callBids: _callBids
  };
};

adaptermanager.registerBidAdapter(new ClickioAdapter(), 'clickio');

module.exports = ClickioAdapter;
