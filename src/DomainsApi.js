"use strict";

class DomainsApi {
  constructor(api) {
    this._api = api;
  }

  request() {
    return this._api.request(...arguments);
  }

  get(domain) {
    return this.request({
      url: `/v1/domains/${domain}`,
    });
  }

  async list() {
    const domains = [];

    for await (const domain of this.listGenerator()) {
      domains.push(domain);
    }

    return domains;
  }

  async *listGenerator() {
    const limit = 100;
    let marker, domains;

    do {
      domains = await this.request({
        url: "/v1/domains",
        data: { marker, limit },
      });

      if (domains.length) {
        for (const domain of domains) {
          yield domain;
        }

        marker = domains[domains.length - 1].domain;
      }
    } while (domains && domains.length === limit);
  }
}

module.exports = DomainsApi;
