import {expect} from 'chai';

import bidManager from 'src/bidmanager';
import adLoader from 'src/adloader';
import * as utils from 'src/utils';
import CONSTANTS from 'src/constants.json';

import ClickioAdapter from 'modules/clickioBidAdapter';

describe('Clickio Adapter Tests', () => {
  let clikioAdapter;
  let sandbox;

  let slotsConfigs;
  let bidsResponse;

  let getCallbackNameFromUrl = function (url) {
    if (!url) {
      return;
    }

    let matches = url.match(/\bf=($$PREBID_GLOBAL$$\.clickio\w+?)\b/m);
    if (!matches || !matches.length || !matches[1]) {
      return;
    }

    return decodeURIComponent(matches[1]);
  };

  let bidsResponses = [];
  let testBids = function (getter, vals, message) {
    bidsResponses.map((bidReponse, i) => {
      expect(getter(bidReponse), message.replace('$i', i + 1)).to.equal(toString.call(vals) === '[object Array]' ? vals[i] : vals);
    });
  };

  beforeEach(() => {
    clikioAdapter = new ClickioAdapter();
    sandbox = sinon.sandbox.create();

    sandbox.stub(bidManager, 'addBidResponse');
    sandbox.stub(adLoader, 'loadScript');

    bidsResponses = [];

    slotsConfigs = {
      bids: [
        {
          placementCode: '/DfpAccount1/slot1',
          sizes: [[728, 90], [300, 250]],

          bidder: 'clickio',
          bidId: 'bid111',
          params: {
            bidsDomain: 'clickio.com',
            siteAreaId: '123456',
            param1: 'value1'
          }
        }, {
          placementCode: '/DfpAccount2/slot2',
          sizes: [[300, 600], [300, 250]],

          bidder: 'clickio',
          bidId: 'bid222',
          params: {
            bidsDomain: 'clickio.com',
            siteAreaId: '456789'
          }
        }, {
          placementCode: '/DfpAccount2/slot2',
          sizes: [[300, 600], [300, 250]],

          bidder: 'clickio',
          bidId: 'bid333',
          params: {
            bidsDomain: 'clickio.com',
            siteAreaId: '456789'
          }
        }
      ]
    };

    bidsResponse = [
      {
        type: 'some other comamand',
        val: 'other command data'
      }, {
        id: '456789.2',
        ad: '<strong>dummy ad 456789.2</strong>',
        cpm: 1.50,
        width: 300,
        height: 250,
      }, {
        id: '123456',
        ad: '<strong>dummy ad 123456</strong>',
        cpm: 0.50,
        width: 728,
        height: 90,
      }, {
        id: '123789',
        ad: '<strong>not requested ad 123789</strong>',
        cpm: 10.00,
        width: 300,
        height: 250,
      }
    ];
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('Verify adapter public interface', () => {
    expect(clikioAdapter.callBids, 'pub method callBids not present').to.exist.and.to.be.a('function');
  });

  it('Verify no errors if no bids', () => {
    let callBidsRes = clikioAdapter.callBids({pids: []});
    expect(callBidsRes, 'call without mandatory params must be handled gracefully and return undefined').to.be.undefined;
    expect(adLoader.loadScript.firstCall).to.be.null;
  });

  it('Verify no errors if bids not array', () => {
    let callBidsRes = clikioAdapter.callBids({bids: '123'});
    expect(callBidsRes, 'call with erroneous params must be handled gracefully and return undefined').to.be.undefined;
    expect(adLoader.loadScript.firstCall).to.be.null;
  });

  it('Verify no errors if bids === empty array', () => {
    let callBidsRes = clikioAdapter.callBids({bids: []});
    expect(callBidsRes, 'call with empty mandatory params must be handled gracefully and return undefined').to.be.undefined;
    expect(adLoader.loadScript.firstCall).to.be.null;
  });

  it('Verify no errors if no siteAreaIds in bids', () => {
    slotsConfigs.bids = slotsConfigs.bids.map(bid => { delete bid.params.siteAreaId; return bid; });
    let callBidsRes = clikioAdapter.callBids(slotsConfigs);
    expect(callBidsRes, 'call with empty mandatory params must be handled gracefully and return undefined').to.be.undefined;
    expect(adLoader.loadScript.firstCall).to.be.null;
  });

  it('Verify no errors if no bidsDomain in bids', () => {
    slotsConfigs.bids = slotsConfigs.bids.map(bid => { delete bid.params.bidsDomain; return bid; });
    let callBidsRes = clikioAdapter.callBids(slotsConfigs);
    expect(callBidsRes, 'call with empty mandatory params must be handled gracefully and return undefined').to.be.undefined;
    expect(adLoader.loadScript.firstCall).to.be.null;
  });

  it('Verify adapter correct url forming and callback creation', () => {
    clikioAdapter.callBids(slotsConfigs);

    let loadUrl = adLoader.loadScript.firstCall.args[0];
    let slotsDomain = slotsConfigs.bids[0].params.bidsDomain;

    expect(loadUrl, 'configured domain not used for url').to.contain('//' + slotsDomain + '/hb/');

    let idsCounters = {};
    let areasIdsStringify = function (bid) {
      let areaId = bid.params.siteAreaId;

      if (!areaId) {
        return;
      }

      if (typeof idsCounters[areaId] === 'undefined') {
        idsCounters[areaId] = 1;
      } else {
        idsCounters[areaId]++;
      }

      return areaId + (idsCounters[areaId] > 1 ? `.${idsCounters[areaId]}` : '');
    };
    let sizesStringify = function (bids) {
      return bids.map(bid => {
        return bid.sizes.map(size => {
          return `${size[0]}x${size[1]}`;
        }).join(',');
      }).join(';');
    };

    let ids = slotsConfigs.bids.map(areasIdsStringify).filter(id => id).join(';');
    expect(loadUrl, 'ids string wrong').to.contain(`/${ids}/`);

    let callbackName = getCallbackNameFromUrl(loadUrl);
    expect(eval(callbackName), 'callback function not instantiated').to.exist.and.to.be.a('function');

    let sizesString = sizesStringify(slotsConfigs.bids);
    expect(loadUrl, 'sizes string wrong').to.contain(encodeURIComponent(sizesString));

    // second call to callBids
    clikioAdapter.callBids(slotsConfigs);

    loadUrl = adLoader.loadScript.secondCall.args[0];

    expect(loadUrl, 'second call, configured domain not used for url').to.contain('//' + slotsDomain + '/hb/');

    ids = slotsConfigs.bids.map(areasIdsStringify).filter(id => id).join(';');
    expect(loadUrl, 'second call, ids string wrong').to.contain(`/${ids}/`);

    let callbackName2 = getCallbackNameFromUrl(loadUrl);
    expect(callbackName2).to.not.equal(callbackName);
    expect(eval(callbackName2)).to.exist.and.to.be.a('function');

    let sizesString2 = sizesStringify(slotsConfigs.bids);
    expect(loadUrl, 'second call, sizes string wrong').to.contain(encodeURIComponent(sizesString2));
    expect(sizesString2, 'second call, sizes string not equal to first call sizes string').to.equal(sizesString);
  });

  it('Verify adapter correct url forming for https', () => {
    sandbox.stub(utils, 'getTopWindowLocation', () => {
      return {
        protocol: 'https:',
        hostname: 'example.com',
        host: 'example.com',
        pathname: '/index.html',
        href: 'http://example.com/index.html'
      };
    });

    clikioAdapter.callBids(slotsConfigs);

    let loadUrl = adLoader.loadScript.firstCall.args[0];

    expect(loadUrl).to.match(/\bhttps=1\b/m);
  });

  it('Verify adapter callback correct empty response handling', () => {
    clikioAdapter.callBids(slotsConfigs);

    let loadUrl = adLoader.loadScript.firstCall.args[0];
    let callbackName = getCallbackNameFromUrl(loadUrl);

    expect(eval(callbackName), 'callback not instantiated').to.exist.and.to.be.a('function');

    let callbackResult = eval(callbackName)([bidsResponse[0]]);

    expect(eval(callbackName), 'callback not removed after call').to.be.undefined;

    expect(callbackResult, 'wrong callback result').to.be.true;

    expect(bidManager.addBidResponse.firstCall.args, 'addBidResponse first call not made or with wrong params').to.be.a('array');
    expect(bidManager.addBidResponse.secondCall.args, 'addBidResponse second call not made or with wrong params').to.be.a('array');
    expect(bidManager.addBidResponse.thirdCall.args, 'addBidResponse third call not made or with wrong params').to.be.a('array');

    bidsResponses.push(bidManager.addBidResponse.firstCall.args);
    bidsResponses.push(bidManager.addBidResponse.secondCall.args);
    bidsResponses.push(bidManager.addBidResponse.thirdCall.args);

    testBids(bidReponse => bidReponse[0], [slotsConfigs.bids[0].placementCode, slotsConfigs.bids[1].placementCode, slotsConfigs.bids[2].placementCode], `wrong placement for bid $i`);
    testBids(bidReponse => bidReponse[1].getStatusCode(), CONSTANTS.STATUS.NO_BID, `wrong status for bid $i`);
    testBids(bidReponse => bidReponse[1].bidderCode, 'clickio', `wrong bidderCode for bid $i`);
    testBids(bidReponse => bidReponse[1].width, 0, `wrong width for bid $i`);
    testBids(bidReponse => bidReponse[1].height, 0, `wrong height for bid $i`);
    testBids(bidReponse => bidReponse[1].cpm || 0, 0, `wrong cpm for bid $i`);
  });

  it('Verify adapter callback correct response handling', () => {
    clikioAdapter.callBids(slotsConfigs);

    let loadUrl = adLoader.loadScript.firstCall.args[0];
    let callbackName = getCallbackNameFromUrl(loadUrl);

    expect(eval(callbackName), 'callback not instantiated').to.exist.and.to.be.a('function');

    let callbackResult = eval(callbackName)(bidsResponse);

    expect(eval(callbackName), 'callback not removed after call').to.be.undefined;

    expect(callbackResult, 'wrong callback result').to.be.true;

    expect(bidManager.addBidResponse.firstCall.args, 'addBidResponse first call not made or with wrong params').to.be.a('array');
    expect(bidManager.addBidResponse.secondCall.args, 'addBidResponse second call not made or with wrong params').to.be.a('array');
    expect(bidManager.addBidResponse.thirdCall.args, 'addBidResponse third call not made or with wrong params').to.be.a('array');

    bidsResponses.push(bidManager.addBidResponse.firstCall.args);
    bidsResponses.push(bidManager.addBidResponse.secondCall.args);
    bidsResponses.push(bidManager.addBidResponse.thirdCall.args);

    let testBids = function (getter, vals, message) {
      bidsResponses.map((bidReponse, i) => { expect(getter(bidReponse), message.replace('$i', i + 1)).to.equal(toString.call(vals) === '[object Array]' ? vals[i] : vals); });
    };

    testBids(bidReponse => bidReponse[0], [slotsConfigs.bids[0].placementCode, slotsConfigs.bids[1].placementCode, slotsConfigs.bids[2].placementCode], `wrong placement for bid $i`);
    testBids(bidReponse => bidReponse[1].getStatusCode(), [CONSTANTS.STATUS.GOOD, CONSTANTS.STATUS.NO_BID, CONSTANTS.STATUS.GOOD], `wrong status for bid $i`);
    testBids(bidReponse => bidReponse[1].bidderCode, 'clickio', `wrong bidderCode for bid $i`);
    testBids(bidReponse => bidReponse[1].width, [bidsResponse[2].width, 0, bidsResponse[1].width], `wrong width for bid $i`);
    testBids(bidReponse => bidReponse[1].height, [bidsResponse[2].height, 0, bidsResponse[1].height], `wrong height for bid $i`);
    testBids(bidReponse => bidReponse[1].cpm || 0, [bidsResponse[2].cpm, 0, bidsResponse[1].cpm], `wrong cpm for bid $i`);
  });
});
