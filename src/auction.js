/**
 * Module for auction instances.
 *
 * In Prebid 0.x, $$PREBID_GLOBAL$$ had _bidsRequested and _bidsReceived as public properties.
 * Starting 1.0, Prebid will support concurrent auctions. Each auction instance will store private properties, bidsRequested and bidsReceived.
 *
 * AuctionManager will create an instance of auction and will store all the auctions.
 *
 */

/**
 * @typedef {import('../src/adapters/bidderFactory.js').BidRequest} BidRequest
 * @typedef {import('../src/adapters/bidderFactory.js').Bid} Bid
 * @typedef {import('../src/config.js').MediaTypePriceGranularity} MediaTypePriceGranularity
 * @typedef {import('../src/mediaTypes.js').MediaType} MediaType
 */

/**
 * @typedef {Object} AdUnit An object containing the adUnit configuration.
 *
 * @property {string} code A code which will be used to uniquely identify this bidder. This should be the same
 *   one as is used in the call to registerBidAdapter
 * @property {Array.<size>} sizes A list of size for adUnit.
 * @property {object} params Any bidder-specific params which the publisher used in their bid request.
 *   This is guaranteed to have passed the spec.areParamsValid() test.
 */

/**
 * @typedef {Array.<number>} size
 */

/**
 * @typedef {Array.<string>} AdUnitCode
 */

/**
 * @typedef {Object} BidderRequest
 *
 * @property {string} bidderCode - adUnit bidder
 * @property {number} auctionId - random UUID
 * @property {string} bidderRequestId - random string, unique key set on all bidRequest.bids[]
 * @property {Array.<Bid>} bids
 * @property {number} auctionStart - Date.now() at auction start
 * @property {number} timeout - callback timeout
 * @property {refererInfo} refererInfo - referer info object
 * @property {string} [tid] - random UUID (used for s2s)
 * @property {string} [src] - s2s or client (used for s2s)
 * @property {import('./types/ortb2.js').Ortb2.BidRequest} [ortb2] Global (not specific to any adUnit) first party data to use for all requests in this auction.
 */

/**
 * @typedef {Object} BidReceived
 * //TODO add all properties
 */

/**
 * @typedef {Object} Auction
 *
 * @property {function(): string} getAuctionStatus - returns the auction status which can be any one of 'started', 'in progress' or 'completed'
 * @property {function(): AdUnit[]} getAdUnits - return the adUnits for this auction instance
 * @property {function(): AdUnitCode[]} getAdUnitCodes - return the adUnitCodes for this auction instance
 * @property {function(): BidRequest[]} getBidRequests - get all bid requests for this auction instance
 * @property {function(): BidReceived[]} getBidsReceived - get all bid received for this auction instance
 * @property {function(): void} startAuctionTimer - sets the bidsBackHandler callback and starts the timer for auction
 * @property {function(): void} callBids - sends requests to all adapters for bids
 */

import {
  generateUUID,
  isEmpty,
  isEmptyStr,
  isFn,
  logError,
  logInfo,
  logMessage,
  logWarn,
  parseUrl,
  timestamp
} from './utils.js';
import {getPriceBucketString} from './cpmBucketManager.js';
import {getNativeTargeting, isNativeResponse, setNativeResponseProperties} from './native.js';
import {batchAndStore, storeLocally} from './videoCache.js';
import {Renderer} from './Renderer.js';
import {config} from './config.js';
import {userSync} from './userSync.js';
import {hook, ignoreCallbackArg} from './hook.js';
import {OUTSTREAM} from './video.js';
import {VIDEO} from './mediaTypes.js';
import {auctionManager} from './auctionManager.js';
import {bidderSettings} from './bidderSettings.js';
import * as events from './events.js';
import adapterManager from './adapterManager.js';
import {EVENTS, GRANULARITY_OPTIONS, JSON_MAPPING, REJECTION_REASON, S2S, TARGETING_KEYS} from './constants.js';
import {defer, PbPromise} from './utils/promise.js';
import {useMetrics} from './utils/perfMetrics.js';
import {adjustCpm} from './utils/cpm.js';
import {getGlobal} from './prebidGlobal.js';
import {ttlCollection} from './utils/ttlCollection.js';
import {getMinBidCacheTTL, onMinBidCacheTTLChange} from './bidTTL.js';

const { syncUsers } = userSync;

export const AUCTION_STARTED = 'started';
export const AUCTION_IN_PROGRESS = 'inProgress';
export const AUCTION_COMPLETED = 'completed';

// register event for bid adjustment
events.on(EVENTS.BID_ADJUSTMENT, function (bid) {
  adjustBids(bid);
});

const MAX_REQUESTS_PER_ORIGIN = 4;
const outstandingRequests = {};
const sourceInfo = {};
const queuedCalls = [];

const pbjsInstance = getGlobal();

/**
 * Clear global state for tests
 */
export function resetAuctionState() {
  queuedCalls.length = 0;
  [outstandingRequests, sourceInfo].forEach((ob) => Object.keys(ob).forEach((k) => { delete ob[k] }));
}

/**
 * Creates new auction instance
 *
 * @param {Object} requestConfig
 * @param {AdUnit} requestConfig.adUnits
 * @param {AdUnitCode} requestConfig.adUnitCodes
 * @param {function():void} requestConfig.callback
 * @param {number} requestConfig.cbTimeout
 * @param {Array.<string>} requestConfig.labels
 * @param {string} requestConfig.auctionId
 * @param {{global: {}, bidder: {}}} requestConfig.ortb2Fragments first party data, separated into global
 *    (from getConfig('ortb2') + requestBids({ortb2})) and bidder (a map from bidderCode to ortb2)
 * @param {Object} requestConfig.metrics
 * @returns {Auction} auction instance
 */
export function newAuction({adUnits, adUnitCodes, callback, cbTimeout, labels, auctionId, ortb2Fragments, metrics}) {
  metrics = useMetrics(metrics);
  const _adUnits = adUnits;
  const _labels = labels;
  const _adUnitCodes = adUnitCodes;
  const _auctionId = auctionId || generateUUID();
  const _timeout = cbTimeout;
  const _timelyRequests = new Set();
  const done = defer();
  const requestsDone = defer();
  let _bidsRejected = [];
  let _callback = callback;
  let _bidderRequests = [];
  let _bidsReceived = ttlCollection({
    startTime: (bid) => bid.responseTimestamp,
    ttl: (bid) => getMinBidCacheTTL() == null ? null : Math.max(getMinBidCacheTTL(), bid.ttl) * 1000
  });
  let _noBids = [];
  let _winningBids = [];
  let _auctionStart;
  let _auctionEnd;
  let _timeoutTimer;
  let _auctionStatus;
  let _nonBids = [];

  onMinBidCacheTTLChange(() => _bidsReceived.refresh());

  function addBidRequests(bidderRequests) { _bidderRequests = _bidderRequests.concat(bidderRequests); }
  function addBidReceived(bid) { _bidsReceived.add(bid); }
  function addBidRejected(bidsRejected) { _bidsRejected = _bidsRejected.concat(bidsRejected); }
  function addNoBid(noBid) { _noBids = _noBids.concat(noBid); }
  function addNonBids(seatnonbids) { _nonBids = _nonBids.concat(seatnonbids); }

  function getProperties() {
    return {
      auctionId: _auctionId,
      timestamp: _auctionStart,
      auctionEnd: _auctionEnd,
      auctionStatus: _auctionStatus,
      adUnits: _adUnits,
      adUnitCodes: _adUnitCodes,
      labels: _labels,
      bidderRequests: _bidderRequests,
      noBids: _noBids,
      bidsReceived: _bidsReceived.toArray(),
      bidsRejected: _bidsRejected,
      winningBids: _winningBids,
      timeout: _timeout,
      metrics: metrics,
      seatNonBids: _nonBids
    };
  }

  function startAuctionTimer() {
    _timeoutTimer = setTimeout(() => executeCallback(true), _timeout);
  }

  function executeCallback(timedOut) {
    if (!timedOut) {
      clearTimeout(_timeoutTimer);
    } else {
      events.emit(EVENTS.AUCTION_TIMEOUT, getProperties());
    }
    if (_auctionEnd === undefined) {
      let timedOutRequests = [];
      if (timedOut) {
        logMessage(`Auction ${_auctionId} timedOut`);
        timedOutRequests = _bidderRequests.filter(rq => !_timelyRequests.has(rq.bidderRequestId)).flatMap(br => br.bids)
        if (timedOutRequests.length) {
          events.emit(EVENTS.BID_TIMEOUT, timedOutRequests);
        }
      }

      _auctionStatus = AUCTION_COMPLETED;
      _auctionEnd = Date.now();
      metrics.checkpoint('auctionEnd');
      metrics.timeBetween('requestBids', 'auctionEnd', 'requestBids.total');
      metrics.timeBetween('callBids', 'auctionEnd', 'requestBids.callBids');
      done.resolve();

      events.emit(EVENTS.AUCTION_END, getProperties());
      bidsBackCallback(_adUnits, function () {
        try {
          if (_callback != null) {
            const bids = _bidsReceived.toArray()
              .filter(bid => _adUnitCodes.includes(bid.adUnitCode))
              .reduce(groupByPlacement, {});
            _callback.apply(pbjsInstance, [bids, timedOut, _auctionId]);
            _callback = null;
          }
        } catch (e) {
          logError('Error executing bidsBackHandler', null, e);
        } finally {
          // Calling timed out bidders
          if (timedOutRequests.length) {
            adapterManager.callTimedOutBidders(adUnits, timedOutRequests, _timeout);
          }
          // Only automatically sync if the publisher has not chosen to "enableOverride"
          let userSyncConfig = config.getConfig('userSync') || {};
          if (!userSyncConfig.enableOverride) {
            // Delay the auto sync by the config delay
            syncUsers(userSyncConfig.syncDelay);
          }
        }
      })
    }
  }

  function auctionDone() {
    config.resetBidder();
    // when all bidders have called done callback atleast once it means auction is complete
    logInfo(`Bids Received for Auction with id: ${_auctionId}`, _bidsReceived.toArray());
    _auctionStatus = AUCTION_COMPLETED;
    executeCallback(false);
  }

  function onTimelyResponse(bidderRequestId) {
    _timelyRequests.add(bidderRequestId);
  }

  function callBids() {
    _auctionStatus = AUCTION_STARTED;
    _auctionStart = Date.now();

    let bidRequests = metrics.measureTime('requestBids.makeRequests',
      () => adapterManager.makeBidRequests(_adUnits, _auctionStart, _auctionId, _timeout, _labels, ortb2Fragments, metrics));
    logInfo(`Bids Requested for Auction with id: ${_auctionId}`, bidRequests);

    metrics.checkpoint('callBids')

    if (bidRequests.length < 1) {
      logWarn('No valid bid requests returned for auction');
      auctionDone();
    } else {
      addBidderRequests.call({
        dispatch: addBidderRequestsCallback,
        context: this
      }, bidRequests);
    }
  }

  /**
   * callback executed after addBidderRequests completes
   * @param {BidRequest[]} bidRequests
   */
  function addBidderRequestsCallback(bidRequests) {
    bidRequests.forEach(bidRequest => {
      addBidRequests(bidRequest);
    });

    let requests = {};
    let call = {
      bidRequests,
      run: () => {
        startAuctionTimer();

        _auctionStatus = AUCTION_IN_PROGRESS;

        events.emit(EVENTS.AUCTION_INIT, getProperties());

        let callbacks = auctionCallbacks(auctionDone, this);
        adapterManager.callBids(_adUnits, bidRequests, callbacks.addBidResponse, callbacks.adapterDone, {
          request(source, origin) {
            increment(outstandingRequests, origin);
            increment(requests, source);

            if (!sourceInfo[source]) {
              sourceInfo[source] = {
                SRA: true,
                origin
              };
            }
            if (requests[source] > 1) {
              sourceInfo[source].SRA = false;
            }
          },
          done(origin) {
            outstandingRequests[origin]--;
            if (queuedCalls[0]) {
              if (runIfOriginHasCapacity(queuedCalls[0])) {
                queuedCalls.shift();
              }
            }
          }
        }, _timeout, onTimelyResponse, ortb2Fragments);
        requestsDone.resolve();
      }
    };

    if (!runIfOriginHasCapacity(call)) {
      logWarn('queueing auction due to limited endpoint capacity');
      queuedCalls.push(call);
    }

    function runIfOriginHasCapacity(call) {
      let hasCapacity = true;

      let maxRequests = config.getConfig('maxRequestsPerOrigin') || MAX_REQUESTS_PER_ORIGIN;

      call.bidRequests.some(bidRequest => {
        let requests = 1;
        let source = (typeof bidRequest.src !== 'undefined' && bidRequest.src === S2S.SRC) ? 's2s'
          : bidRequest.bidderCode;
        // if we have no previous info on this source just let them through
        if (sourceInfo[source]) {
          if (sourceInfo[source].SRA === false) {
            // some bidders might use more than the MAX_REQUESTS_PER_ORIGIN in a single auction.  In those cases
            // set their request count to MAX_REQUESTS_PER_ORIGIN so the auction isn't permanently queued waiting
            // for capacity for that bidder
            requests = Math.min(bidRequest.bids.length, maxRequests);
          }
          if (outstandingRequests[sourceInfo[source].origin] + requests > maxRequests) {
            hasCapacity = false;
          }
        }
        // return only used for terminating this .some() iteration early if it is determined we don't have capacity
        return !hasCapacity;
      });

      if (hasCapacity) {
        call.run();
      }

      return hasCapacity;
    }

    function increment(obj, prop) {
      if (typeof obj[prop] === 'undefined') {
        obj[prop] = 1
      } else {
        obj[prop]++;
      }
    }
  }

  function addWinningBid(winningBid) {
    _winningBids = _winningBids.concat(winningBid);
    adapterManager.callBidWonBidder(winningBid.adapterCode || winningBid.bidder, winningBid, adUnits);
    if (!winningBid.deferBilling) {
      adapterManager.triggerBilling(winningBid)
    }
  }

  function setBidTargeting(bid) {
    adapterManager.callSetTargetingBidder(bid.adapterCode || bid.bidder, bid);
  }

  events.on(EVENTS.SEAT_NON_BID, (event) => {
    if (event.auctionId === _auctionId) {
      addNonBids(event.seatnonbid)
    }
  });

  return {
    addBidReceived,
    addBidRejected,
    addNoBid,
    callBids,
    addWinningBid,
    setBidTargeting,
    getWinningBids: () => _winningBids,
    getAuctionStart: () => _auctionStart,
    getAuctionEnd: () => _auctionEnd,
    getTimeout: () => _timeout,
    getAuctionId: () => _auctionId,
    getAuctionStatus: () => _auctionStatus,
    getAdUnits: () => _adUnits,
    getAdUnitCodes: () => _adUnitCodes,
    getBidRequests: () => _bidderRequests,
    getBidsReceived: () => _bidsReceived.toArray(),
    getNoBids: () => _noBids,
    getNonBids: () => _nonBids,
    getFPD: () => ortb2Fragments,
    getMetrics: () => metrics,
    end: done.promise,
    requestsDone: requestsDone.promise,
    getProperties
  };
}

/**
 * Hook into this to intercept bids before they are added to an auction.
 *
 * @type {Function}
 * @param adUnitCode
 * @param bid
 * @param {function(String): void} reject a function that, when called, rejects `bid` with the given reason.
 */
export const addBidResponse = ignoreCallbackArg(hook('async', function(adUnitCode, bid, reject) {
  if (!isValidPrice(bid)) {
    reject(REJECTION_REASON.PRICE_TOO_HIGH)
  } else {
    this.dispatch.call(null, adUnitCode, bid);
  }
}, 'addBidResponse'));

/**
 * Delay hook for adapter responses.
 *
 * `ready` is a promise; auctions wait for it to resolve before closing. Modules can hook into this
 * to delay the end of auctions while they perform initialization that does not need to delay their start.
 */
export const responsesReady = hook('sync', (ready) => ready, 'responsesReady');

export const addBidderRequests = hook('sync', function(bidderRequests) {
  this.dispatch.call(this.context, bidderRequests);
}, 'addBidderRequests');

export const bidsBackCallback = hook('async', function (adUnits, callback) {
  if (callback) {
    callback();
  }
}, 'bidsBackCallback');

export function auctionCallbacks(auctionDone, auctionInstance, {index = auctionManager.index} = {}) {
  let outstandingBidsAdded = 0;
  let allAdapterCalledDone = false;
  let bidderRequestsDone = new Set();
  let bidResponseMap = {};

  function afterBidAdded() {
    outstandingBidsAdded--;
    if (allAdapterCalledDone && outstandingBidsAdded === 0) {
      auctionDone()
    }
  }

  function handleBidResponse(adUnitCode, bid, handler) {
    bidResponseMap[bid.requestId] = true;
    addCommonResponseProperties(bid, adUnitCode)
    outstandingBidsAdded++;
    return handler(afterBidAdded);
  }

  function acceptBidResponse(adUnitCode, bid) {
    handleBidResponse(adUnitCode, bid, (done) => {
      let bidResponse = getPreparedBidForAuction(bid);
      events.emit(EVENTS.BID_ACCEPTED, bidResponse);
      if (FEATURES.VIDEO && bidResponse.mediaType === VIDEO) {
        tryAddVideoBid(auctionInstance, bidResponse, done);
      } else {
        if (FEATURES.NATIVE && isNativeResponse(bidResponse)) {
          setNativeResponseProperties(bidResponse, index.getAdUnit(bidResponse));
        }
        addBidToAuction(auctionInstance, bidResponse);
        done();
      }
    });
  }

  function rejectBidResponse(adUnitCode, bid, reason) {
    return handleBidResponse(adUnitCode, bid, (done) => {
      bid.rejectionReason = reason;
      logWarn(`Bid from ${bid.bidder || 'unknown bidder'} was rejected: ${reason}`, bid)
      events.emit(EVENTS.BID_REJECTED, bid);
      auctionInstance.addBidRejected(bid);
      done();
    })
  }

  function adapterDone() {
    let bidderRequest = this;
    let bidderRequests = auctionInstance.getBidRequests();
    const auctionOptionsConfig = config.getConfig('auctionOptions');

    bidderRequestsDone.add(bidderRequest);

    if (auctionOptionsConfig && !isEmpty(auctionOptionsConfig)) {
      const secondaryBidders = auctionOptionsConfig.secondaryBidders;
      if (secondaryBidders && !bidderRequests.every(bidder => secondaryBidders.includes(bidder.bidderCode))) {
        bidderRequests = bidderRequests.filter(request => !secondaryBidders.includes(request.bidderCode));
      }
    }

    allAdapterCalledDone = bidderRequests.every(bidderRequest => bidderRequestsDone.has(bidderRequest));

    bidderRequest.bids.forEach(bid => {
      if (!bidResponseMap[bid.bidId]) {
        auctionInstance.addNoBid(bid);
        events.emit(EVENTS.NO_BID, bid);
      }
    });

    if (allAdapterCalledDone && outstandingBidsAdded === 0) {
      auctionDone();
    }
  }

  return {
    addBidResponse: (function () {
      function addBid(adUnitCode, bid) {
        addBidResponse.call({
          dispatch: acceptBidResponse,
        }, adUnitCode, bid, (() => {
          let rejected = false;
          return (reason) => {
            if (!rejected) {
              rejectBidResponse(adUnitCode, bid, reason);
              rejected = true;
            }
          }
        })())
      }
      addBid.reject = rejectBidResponse;
      return addBid;
    })(),
    adapterDone: function () {
      responsesReady(PbPromise.resolve()).finally(() => adapterDone.call(this));
    }
  }
}

// Add a bid to the auction.
export function addBidToAuction(auctionInstance, bidResponse) {
  setupBidTargeting(bidResponse);

  useMetrics(bidResponse.metrics).timeSince('addBidResponse', 'addBidResponse.total');
  auctionInstance.addBidReceived(bidResponse);
  events.emit(EVENTS.BID_RESPONSE, bidResponse);
}

// Video bids may fail if the cache is down, or there's trouble on the network.
function tryAddVideoBid(auctionInstance, bidResponse, afterBidAdded, {index = auctionManager.index} = {}) {
  let addBid = true;

  const videoMediaType = index.getMediaTypes({
    requestId: bidResponse.originalRequestId || bidResponse.requestId,
    adUnitId: bidResponse.adUnitId
  })?.video;
  const context = videoMediaType && videoMediaType?.context;
  const useCacheKey = videoMediaType && videoMediaType?.useCacheKey;
  const {
    useLocal,
    url: cacheUrl,
    ignoreBidderCacheKey
  } = config.getConfig('cache') || {};

  if (useLocal) {
    // stores video bid vast as local blob in the browser
    storeLocally(bidResponse);
  } else if (cacheUrl && (useCacheKey || context !== OUTSTREAM)) {
    if (!bidResponse.videoCacheKey || ignoreBidderCacheKey) {
      addBid = false;
      callPrebidCache(auctionInstance, bidResponse, afterBidAdded, videoMediaType);
    } else if (!bidResponse.vastUrl) {
      logError('videoCacheKey specified but not required vastUrl for video bid');
      addBid = false;
    }
  }

  if (addBid) {
    addBidToAuction(auctionInstance, bidResponse);
    afterBidAdded();
  }
}

export const callPrebidCache = hook('async', function(auctionInstance, bidResponse, afterBidAdded, videoMediaType) {
  if (FEATURES.VIDEO) {
    batchAndStore(auctionInstance, bidResponse, afterBidAdded);
  }
}, 'callPrebidCache');

/**
 * Augment `bidResponse` with properties that are common across all bids - including rejected bids.
 *
 */
function addCommonResponseProperties(bidResponse, adUnitCode, {index = auctionManager.index} = {}) {
  const bidderRequest = index.getBidderRequest(bidResponse);
  const adUnit = index.getAdUnit(bidResponse);
  const start = (bidderRequest && bidderRequest.start) || bidResponse.requestTimestamp;

  Object.assign(bidResponse, {
    responseTimestamp: bidResponse.responseTimestamp || timestamp(),
    requestTimestamp: bidResponse.requestTimestamp || start,
    cpm: parseFloat(bidResponse.cpm) || 0,
    bidder: bidResponse.bidder || bidResponse.bidderCode,
    adUnitCode
  });

  if (adUnit?.ttlBuffer != null) {
    bidResponse.ttlBuffer = adUnit.ttlBuffer;
  }

  // window.console.groupCollapsed('addCommonResponseProperties (' + bidResponse.bidder + ')');
  //   window.console.groupCollapsed('adUnitCode');
  //   window.console.log(adUnitCode);
  //   window.console.groupEnd();
  //
  //   window.console.groupCollapsed('bidderRequest');
  //   window.console.log(bidderRequest);
  //   window.console.groupEnd();
  //
  //   window.console.groupCollapsed('bidResponse');
  //   window.console.log(bidResponse);
  //   window.console.groupEnd();
  //
  // window.console.groupEnd();

  bidResponse.timeToRespond = bidResponse.responseTimestamp - bidResponse.requestTimestamp;

  const bidReq           = bidderRequest && bidderRequest.bids && bidderRequest.bids.find(bid => bid.adUnitCode == adUnitCode && bid.bidId == bidResponse.requestId);
  bidResponse.__sds_id__ = bidReq.__sds_id__;
}

/**
 * Add additional bid response properties that are universal for all _accepted_ bids.
 */
function getPreparedBidForAuction(bid, {index = auctionManager.index} = {}) {
  // Let listeners know that now is the time to adjust the bid, if they want to.
  //
  // CAREFUL: Publishers rely on certain bid properties to be available (like cpm),
  // but others to not be set yet (like priceStrings). See #1372 and #1389.
  events.emit(EVENTS.BID_ADJUSTMENT, bid);

  const adUnit = index.getAdUnit(bid);
  bid.instl = adUnit?.ortb2Imp?.instl === 1;

  // a publisher-defined renderer can be used to render bids
  const bidRenderer = index.getBidRequest(bid)?.renderer || adUnit.renderer;

  // a publisher can also define a renderer for a mediaType
  const bidObjectMediaType = bid.mediaType;
  const mediaTypes = index.getMediaTypes(bid);
  const bidMediaType = mediaTypes && mediaTypes[bidObjectMediaType];

  var mediaTypeRenderer = bidMediaType && bidMediaType.renderer;

  var renderer = null;

  // the renderer for the mediaType takes precendence
  if (mediaTypeRenderer && mediaTypeRenderer.render && !(mediaTypeRenderer.backupOnly === true && bid.renderer)) {
    renderer = mediaTypeRenderer;
  } else if (bidRenderer && bidRenderer.render && !(bidRenderer.backupOnly === true && bid.renderer)) {
    renderer = bidRenderer;
  }

  if (renderer) {
    // be aware, an adapter could already have installed the bidder, in which case this overwrite's the existing adapter
    bid.renderer = Renderer.install({ url: renderer.url, config: renderer.options, renderNow: renderer.url == null });// rename options to config, to make it consistent?
    bid.renderer.setRender(renderer.render);
  }

  // Use the config value 'mediaTypeGranularity' if it has been defined for mediaType, else use 'customPriceBucket'
  const mediaTypeGranularity = getMediaTypeGranularity(bid.mediaType, mediaTypes, config.getConfig('mediaTypePriceGranularity'));
  const priceStringsObj = getPriceBucketString(
    bid.cpm,
    (typeof mediaTypeGranularity === 'object') ? mediaTypeGranularity : config.getConfig('customPriceBucket'),
    config.getConfig('currency.granularityMultiplier')
  );
  bid.pbLg = priceStringsObj.low;
  bid.pbMg = priceStringsObj.med;
  bid.pbHg = priceStringsObj.high;
  bid.pbAg = priceStringsObj.auto;
  bid.pbDg = priceStringsObj.dense;
  bid.pbCg = priceStringsObj.custom;

  return bid;
}

function setupBidTargeting(bidObject) {
  let keyValues;
  const cpmCheck = (bidderSettings.get(bidObject.bidderCode, 'allowZeroCpmBids') === true) ? bidObject.cpm >= 0 : bidObject.cpm > 0;
  if (bidObject.bidderCode && (cpmCheck || bidObject.dealId)) {
    keyValues = getKeyValueTargetingPairs(bidObject.bidderCode, bidObject);
  }

  // use any targeting provided as defaults, otherwise just set from getKeyValueTargetingPairs
  bidObject.adserverTargeting = Object.assign(bidObject.adserverTargeting || {}, keyValues);
}

/**
 * @param {MediaType} mediaType
 * @param mediaTypes media types map from adUnit
 * @param {MediaTypePriceGranularity} [mediaTypePriceGranularity]
 * @returns {(Object|string|undefined)}
 */
export function getMediaTypeGranularity(mediaType, mediaTypes, mediaTypePriceGranularity) {
  if (mediaType && mediaTypePriceGranularity) {
    if (FEATURES.VIDEO && mediaType === VIDEO) {
      const context = mediaTypes?.[VIDEO]?.context ?? 'instream';
      if (mediaTypePriceGranularity[`${VIDEO}-${context}`]) {
        return mediaTypePriceGranularity[`${VIDEO}-${context}`];
      }
    }
    return mediaTypePriceGranularity[mediaType];
  }
}

/**
 * This function returns the price granularity defined. It can be either publisher defined or default value
 * @param {Bid} bid bid response object
 * @param {object} obj
 * @param {object} obj.index
 * @returns {string} granularity
 */
export const getPriceGranularity = (bid, {index = auctionManager.index} = {}) => {
  // Use the config value 'mediaTypeGranularity' if it has been set for mediaType, else use 'priceGranularity'
  const mediaTypeGranularity = getMediaTypeGranularity(bid.mediaType, index.getMediaTypes(bid), config.getConfig('mediaTypePriceGranularity'));
  const granularity = (typeof bid.mediaType === 'string' && mediaTypeGranularity) ? ((typeof mediaTypeGranularity === 'string') ? mediaTypeGranularity : 'custom') : config.getConfig('priceGranularity');
  return granularity;
}

/**
 * This function returns a function to get bid price by price granularity
 * @param {string} granularity
 * @returns {function}
 */
export const getPriceByGranularity = (granularity) => {
  return (bid) => {
    const bidGranularity = granularity || getPriceGranularity(bid);
    if (bidGranularity === GRANULARITY_OPTIONS.AUTO) {
      return bid.pbAg;
    } else if (bidGranularity === GRANULARITY_OPTIONS.DENSE) {
      return bid.pbDg;
    } else if (bidGranularity === GRANULARITY_OPTIONS.LOW) {
      return bid.pbLg;
    } else if (bidGranularity === GRANULARITY_OPTIONS.MEDIUM) {
      return bid.pbMg;
    } else if (bidGranularity === GRANULARITY_OPTIONS.HIGH) {
      return bid.pbHg;
    } else if (bidGranularity === GRANULARITY_OPTIONS.CUSTOM) {
      return bid.pbCg;
    }
  }
}

/**
 * This function returns a function to get crid from bid response
 * @returns {function}
 */
export const getCreativeId = () => {
  return (bid) => {
    return (bid.creativeId) ? bid.creativeId : '';
  }
}

/**
 * This function returns a function to get first advertiser domain from bid response meta
 * @returns {function}
 */
export const getAdvertiserDomain = () => {
  return (bid) => {
    return (bid.meta && bid.meta.advertiserDomains && bid.meta.advertiserDomains.length > 0) ? [bid.meta.advertiserDomains].flat()[0] : '';
  }
}

/**
 * This function returns a function to get dsp name or id from bid response meta
 * @returns {function}
 */
export const getDSP = () => {
  return (bid) => {
    return (bid.meta && (bid.meta.networkId || bid.meta.networkName)) ? bid?.meta?.networkName || bid?.meta?.networkId : '';
  }
}

/**
 * This function returns a function to get the primary category id from bid response meta
 * @returns {function}
 */
export const getPrimaryCatId = () => {
  return (bid) => {
    const catId = bid?.meta?.primaryCatId;
    if (Array.isArray(catId)) {
      return catId[0] || '';
    }
    return catId || '';
  };
}

// factory for key value objs
function createKeyVal(key, value) {
  return {
    key,
    val: (typeof value === 'function')
      ? function (bidResponse, bidReq) {
        return value(bidResponse, bidReq);
      }
      : function (bidResponse) {
        return bidResponse[value];
      }
  };
}

function defaultAdserverTargeting() {
  return [
    createKeyVal(TARGETING_KEYS.BIDDER, 'bidderCode'),
    createKeyVal(TARGETING_KEYS.AD_ID, 'adId'),
    createKeyVal(TARGETING_KEYS.PRICE_BUCKET, getPriceByGranularity()),
    createKeyVal(TARGETING_KEYS.SIZE, 'size'),
    createKeyVal(TARGETING_KEYS.DEAL, 'dealId'),
    createKeyVal(TARGETING_KEYS.SOURCE, 'source'),
    createKeyVal(TARGETING_KEYS.FORMAT, 'mediaType'),
    createKeyVal(TARGETING_KEYS.ADOMAIN, getAdvertiserDomain()),
    createKeyVal(TARGETING_KEYS.ACAT, getPrimaryCatId()),
    createKeyVal(TARGETING_KEYS.DSP, getDSP()),
    createKeyVal(TARGETING_KEYS.CRID, getCreativeId()),
  ]
}

/**
 * @param {string} mediaType
 * @param {string} bidderCode
 * @returns {*}
 */
export function getStandardBidderSettings(mediaType, bidderCode) {
  const standardSettings = Object.assign({}, bidderSettings.settingsFor(null));
  if (!standardSettings[JSON_MAPPING.ADSERVER_TARGETING]) {
    standardSettings[JSON_MAPPING.ADSERVER_TARGETING] = defaultAdserverTargeting();
  }

  if (FEATURES.VIDEO && mediaType === 'video') {
    const adserverTargeting = standardSettings[JSON_MAPPING.ADSERVER_TARGETING].slice();
    standardSettings[JSON_MAPPING.ADSERVER_TARGETING] = adserverTargeting;

    // Adding hb_uuid + hb_cache_id
    [TARGETING_KEYS.UUID, TARGETING_KEYS.CACHE_ID].forEach(targetingKeyVal => {
      if (typeof adserverTargeting.find(kvPair => kvPair.key === targetingKeyVal) === 'undefined') {
        adserverTargeting.push(createKeyVal(targetingKeyVal, 'videoCacheKey'));
      }
    });

    // Adding hb_cache_host
    if (config.getConfig('cache.url') && (!bidderCode || bidderSettings.get(bidderCode, 'sendStandardTargeting') !== false)) {
      const urlInfo = parseUrl(config.getConfig('cache.url'));

      if (typeof adserverTargeting.find(targetingKeyVal => targetingKeyVal.key === TARGETING_KEYS.CACHE_HOST) === 'undefined') {
        adserverTargeting.push(createKeyVal(TARGETING_KEYS.CACHE_HOST, function(bidResponse) {
          return bidResponse?.adserverTargeting?.[TARGETING_KEYS.CACHE_HOST] || urlInfo.hostname;
        }));
      }
    }
  }

  return standardSettings;
}

export function getKeyValueTargetingPairs(bidderCode, custBidObj, {index = auctionManager.index} = {}) {
  if (!custBidObj) {
    return {};
  }
  const bidRequest = index.getBidRequest(custBidObj);
  var keyValues = {};

  // 1) set the keys from "standard" setting or from prebid defaults
  // initialize default if not set
  const standardSettings = getStandardBidderSettings(custBidObj.mediaType, bidderCode);
  setKeys(keyValues, standardSettings, custBidObj, bidRequest);

  // 2) set keys from specific bidder setting override if they exist
  if (bidderCode && bidderSettings.getOwn(bidderCode, JSON_MAPPING.ADSERVER_TARGETING)) {
    setKeys(keyValues, bidderSettings.ownSettingsFor(bidderCode), custBidObj, bidRequest);
    custBidObj.sendStandardTargeting = bidderSettings.get(bidderCode, 'sendStandardTargeting');
  }

  // set native key value targeting
  if (FEATURES.NATIVE && custBidObj['native']) {
    keyValues = Object.assign({}, keyValues, getNativeTargeting(custBidObj));
  }

  return keyValues;
}

function setKeys(keyValues, bidderSettings, custBidObj, bidReq) {
  var targeting = bidderSettings[JSON_MAPPING.ADSERVER_TARGETING];
  custBidObj.size = custBidObj.getSize();

  (targeting || []).forEach(function (kvPair) {
    var key = kvPair.key;
    var value = kvPair.val;

    if (keyValues[key]) {
      logWarn('The key: ' + key + ' is being overwritten');
    }

    if (isFn(value)) {
      try {
        value = value(custBidObj, bidReq);
      } catch (e) {
        logError('bidmanager', 'ERROR', e);
      }
    }

    if (
      ((typeof bidderSettings.suppressEmptyKeys !== 'undefined' && bidderSettings.suppressEmptyKeys === true) ||
        key === TARGETING_KEYS.DEAL || key === TARGETING_KEYS.ACAT || key === TARGETING_KEYS.DSP || key === TARGETING_KEYS.CRID) && // hb_deal & hb_acat are suppressed automatically if not set
      (
        isEmptyStr(value) ||
        value === null ||
        value === undefined
      )
    ) {
      logInfo("suppressing empty key '" + key + "' from adserver targeting");
    } else {
      keyValues[key] = value;
    }
  });

  return keyValues;
}

export function adjustBids(bid) {
  let bidPriceAdjusted = adjustCpm(bid.cpm, bid);

  if (bidPriceAdjusted >= 0) {
    bid.cpm = bidPriceAdjusted;
  }
}

/**
 * groupByPlacement is a reduce function that converts an array of Bid objects
 * to an object with placement codes as keys, with each key representing an object
 * with an array of `Bid` objects for that placement
 * @returns {*} as { [adUnitCode]: { bids: [Bid, Bid, Bid] } }
 */
function groupByPlacement(bidsByPlacement, bid) {
  if (!bidsByPlacement[bid.adUnitCode]) { bidsByPlacement[bid.adUnitCode] = { bids: [] }; }
  bidsByPlacement[bid.adUnitCode].bids.push(bid);
  return bidsByPlacement;
}

/**
 * isValidPrice is price validation function
 * which checks if price from bid response
 * is not higher than top limit set in config
 * @type {Function}
 * @param bid
 * @returns {boolean}
 */
function isValidPrice(bid) {
  const maxBidValue = config.getConfig('maxBid');
  if (!maxBidValue || !bid.cpm) return true;
  return maxBidValue >= Number(bid.cpm);
}
