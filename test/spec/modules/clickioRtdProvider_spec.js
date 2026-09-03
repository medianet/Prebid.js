import { buildWrapper, clickioRtdProvider, isValidConfig, shouldWrap } from 'modules/clickioRtdProvider.ts';

describe('Clickio RTD provider', function () {
  const params = { reportUrl: 'https://stats.example/redirect' };

  it('registers under the clickio provider name', function () {
    expect(clickioRtdProvider.name).to.equal('clickio');
  });

  describe('init', function () {
    it('accepts a valid configuration', function () {
      expect(clickioRtdProvider.init({ name: 'clickio', params }, {})).to.equal(true);
    });

    it('rejects missing and non-HTTPS report URLs', function () {
      expect(isValidConfig({})).to.equal(false);
      expect(isValidConfig({ params: { reportUrl: 'http://stats.example' } })).to.equal(false);
    });

    it('validates optional parameters', function () {
      expect(isValidConfig({ params: { ...params, bidders: ['a'], activationTtl: 0 } })).to.equal(true);
      expect(isValidConfig({ params: { ...params, bidders: [1] } })).to.equal(false);
      expect(isValidConfig({ params: { ...params, activationTtl: -1 } })).to.equal(false);
    });
  });

  describe('bid wrapping', function () {
    it('wraps banner markup in a navigation-restricted sandbox', function () {
      const bid = { ad: '<div>creative</div>', bidderCode: 'demand', adId: 'ad-1' };
      clickioRtdProvider.onBidResponseEvent(bid, { name: 'clickio', params }, {});

      expect(bid.ad).to.include('allow-top-navigation-by-user-activation');
      expect(bid.ad).to.include('window.open=function');
      expect(bid.ad).to.include('keepalive:true');
      expect(bid.ad).to.include(encodeURIComponent('<div>creative</div>'));
      expect(bid.ad).to.not.include('allow-top-navigation\'');
    });

    it('includes compact bid metadata and the configured report URL', function () {
      const wrapped = buildWrapper('<div/>', {
        adId: 'ad-1', auctionId: 'auction-1', bidderCode: 'demand', creativeId: 'creative-1'
      }, params);

      expect(decodeURIComponent(wrapped)).to.include('automatic_redirect_blocked');
      expect(decodeURIComponent(wrapped)).to.include(params.reportUrl);
      expect(decodeURIComponent(wrapped)).to.include('creative-1');
    });

    it('does not expose creative markup as executable wrapper source', function () {
      const malicious = '</script><script>window.wrapperEscaped=true</script>';
      const wrapped = buildWrapper(malicious, {}, params);
      expect(wrapped).to.not.include(malicious);
      expect(wrapped).to.include(encodeURIComponent(malicious));
    });

    it('honors the bidder allow-list and ignores non-banner responses', function () {
      expect(shouldWrap({ ad: '<div/>', bidderCode: 'allowed' }, { ...params, bidders: ['allowed'] })).to.equal(true);
      expect(shouldWrap({ ad: '<div/>', bidderCode: 'other' }, { ...params, bidders: ['allowed'] })).to.equal(false);
      expect(shouldWrap({ vastUrl: 'https://video.example' }, params)).to.equal(false);
    });

    it('does not mutate responses from bidders outside the allow-list', function () {
      const bid = { ad: '<div>untouched</div>', bidderCode: 'other', customField: { value: 1 } };
      const snapshot = JSON.parse(JSON.stringify(bid));

      clickioRtdProvider.onBidResponseEvent(bid, {
        name: 'clickio',
        params: { ...params, bidders: ['allowed'] }
      }, {});

      expect(bid).to.deep.equal(snapshot);
    });
  });
});
