/**
 * Wraps banner creatives in a sandbox that only permits navigation after user activation.
 * @module modules/clickioRtdProvider
 * @requires module:modules/realTimeData
 */

import { submodule } from '../src/hook.js';
import { logError } from '../src/utils.js';
import type { Bid } from '../src/bidfactory.ts';
import type { AllConsentData } from '../src/consentHandler.ts';
import type { ProviderConfig, RTDProviderConfig, RtdProviderSpec } from './rtdModule/spec.ts';

const SUBMODULE_NAME = 'clickio';
const DEFAULT_ACTIVATION_TTL = 1000;

export type ClickioRtdParams = {
  /** HTTPS endpoint that receives reports about blocked automatic navigation. */
  reportUrl: string;
  /** Optional allow-list of bidder codes. All bidders are wrapped when omitted. */
  bidders?: string[];
  /** How long, in milliseconds, a trusted gesture authorizes navigation. */
  activationTtl?: number;
};

declare module './rtdModule/spec.ts' {
  interface ProviderConfig {
    clickio: {
      params: ClickioRtdParams;
    };
  }
}

type ClickioConfig = ProviderConfig['clickio'];
type ClickioRtdProviderSpec = RtdProviderSpec<'clickio'> & {
  onBidResponseEvent: (bid: Bid, config: RTDProviderConfig<'clickio'>, consent: AllConsentData) => void;
};

function encode(value: string): string {
  return JSON.stringify(encodeURIComponent(value));
}

/**
 * Build an isolated document around a banner creative. The nested sandbox is the
 * enforcement boundary; the injected guards add reporting for observable attempts.
 */
export function buildWrapper(ad: string, bid: {
  adId?: unknown;
  auctionId?: unknown;
  bidderCode?: unknown;
  creativeId?: unknown;
}, params: ClickioRtdParams): string {
  const ttl = params.activationTtl ?? DEFAULT_ACTIVATION_TTL;
  const report = JSON.stringify({
    event: 'automatic_redirect_blocked',
    adId: bid.adId,
    auctionId: bid.auctionId,
    bidder: bid.bidderCode,
    creativeId: bid.creativeId
  });

  const guard = `<script>(function(){
var until=0,ttl=${ttl},nativeOpen=window.open;
function active(){return !!(navigator.userActivation&&navigator.userActivation.isActive)||Date.now()<until}
function trust(e){if(e.isTrusted)until=Date.now()+ttl}
function report(kind,url){parent.postMessage({clickioRedirectGuard:true,kind:kind,url:String(url||'')},'*')}
addEventListener('pointerdown',trust,true);addEventListener('touchstart',trust,true);addEventListener('keydown',trust,true);
window.open=function(url){if(!active()){report('window.open',url);return null}return nativeOpen.apply(this,arguments)};
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a&&!active()&&!e.isTrusted){e.preventDefault();e.stopImmediatePropagation();report('anchor',a.href)}},true);
document.addEventListener('submit',function(e){if(!active()){e.preventDefault();e.stopImmediatePropagation();report('form',e.target&&e.target.action)}},true);
}());<\/script>`;

  return `<script>(function(){
var frame=document.createElement('iframe');
frame.setAttribute('sandbox','allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
frame.setAttribute('scrolling','no');frame.setAttribute('frameborder','0');frame.style.cssText='border:0;width:100%;height:100%';
addEventListener('message',function(e){var d=e.data;if(e.source!==frame.contentWindow||!d||d.clickioRedirectGuard!==true)return;
var payload=${encode(report)};try{var data=JSON.parse(decodeURIComponent(payload));data.kind=d.kind;data.url=d.url;
fetch(decodeURIComponent(${encode(params.reportUrl)}),{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'text/plain'},keepalive:true,mode:'no-cors',credentials:'omit'}).catch(function(){});}catch(ignore){}
});
frame.srcdoc=decodeURIComponent(${encode(guard + ad)});document.body.style.margin='0';document.body.appendChild(frame);
}());<\/script>`;
}

export function isValidConfig(config: Partial<ClickioConfig>): config is ClickioConfig {
  const params = config?.params;
  return !!params && typeof params.reportUrl === 'string' && /^https:\/\//.test(params.reportUrl) &&
    (params.bidders == null || (Array.isArray(params.bidders) && params.bidders.every((bidder) => typeof bidder === 'string'))) &&
    (params.activationTtl == null || (Number.isFinite(params.activationTtl) && params.activationTtl >= 0));
}

export function shouldWrap(bid: { ad?: unknown; bidderCode?: unknown }, params: ClickioRtdParams): bid is typeof bid & { ad: string } {
  return typeof bid.ad === 'string' &&
    (params.bidders == null || params.bidders.includes(String(bid.bidderCode)));
}

export const clickioRtdProvider: ClickioRtdProviderSpec = {
  name: SUBMODULE_NAME,
  init(config) {
    if (!isValidConfig(config)) {
      logError('Clickio RTD provider: params.reportUrl must be an HTTPS URL; bidders and activationTtl must be valid when provided.');
      return false;
    }
    return true;
  },
  onBidResponseEvent(bidResponse, config) {
    if (shouldWrap(bidResponse, config.params)) {
      bidResponse.ad = buildWrapper(bidResponse.ad, bidResponse, config.params);
    }
  }
};

submodule('realTimeData', clickioRtdProvider);
