# Clickio RTD Provider

The Clickio RTD provider wraps HTML banner bid responses in a browser sandbox. Top-frame navigation is allowed only after a user activation; observable automatic navigation attempts are blocked and reported to a publisher-configured HTTPS endpoint. It can protect every demand response on the site or only selected bidders without changing responses from other bidders.

## Activation

The provider is disabled by default. Including `clickioRtdProvider` in a build only registers it with the RTD module. It does not wrap creatives, install browser event handlers, or send requests unless `realTimeData.dataProviders` contains an entry with `name: 'clickio'` and valid parameters.

## Site-wide configuration

Omit `bidders` to wrap HTML banner responses from every demand source on the site:

```javascript
pbjs.setConfig({
  realTimeData: {
    dataProviders: [{
      name: 'clickio',
      params: {
        reportUrl: 'https://example.com/clickio/redirect-stat',
        activationTtl: 1000
      }
    }]
  }
});
```

## Configuration for selected demand sources

Set `bidders` to wrap only the listed demand sources. This example enables protection for AppNexus and Rubicon while leaving every other bidder response unchanged:

```javascript
pbjs.setConfig({
  realTimeData: {
    dataProviders: [{
      name: 'clickio',
      params: {
        reportUrl: 'https://example.com/clickio/redirect-stat',
        bidders: ['appnexus', 'rubicon'],
        activationTtl: 1000
      }
    }]
  }
});
```

## Parameters

`reportUrl` is required and must use HTTPS. `bidders` is an optional bidder-code allow-list:

- omit `bidders` to wrap HTML banner responses from every demand source;
- set `bidders: ['bidderA', 'bidderB']` to wrap only those demand sources. Responses from every other bidder remain unchanged.

`activationTtl` optionally controls how many milliseconds a trusted pointer, touch, or keyboard event authorizes navigation and defaults to 1000.

Reports are sent as JSON in a `text/plain` POST using `fetch` with `keepalive`. They contain the event name, redirect mechanism and URL, plus the available `adId`, `auctionId`, `bidder`, and `creativeId`. The provider does not wrap video, native, or `adUrl` responses.

Build the provider together with the RTD module:

```shell
gulp build --modules=rtdModule,clickioRtdProvider
```
