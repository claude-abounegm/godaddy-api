"use strict";

const _ = require("lodash");
const ipify = require("ipify");
const rp = require("request-promise-native");

class GoDaddy {
  constructor(opts) {
    const { OTE, key, secret, priceLimit, privacyPrice } = opts;

    this._apiUrl = `https://api.${OTE ? "ote-" : ""}godaddy.com`;
    this._authorization = `sso-key ${key}:${secret}`;
    this._priceLimit = priceLimit;
    this._privacyPrice = privacyPrice || 10;
  }

  get priceLimit() {
    return this._priceLimit;
  }

  get apiUrl() {
    return this._apiUrl;
  }

  async request(opts) {
    try {
      let { url, method = "GET", data } = opts || {};

      if (!_.isString(url)) {
        throw new Error("url needs to be a string");
      }

      let qs, body;
      if (method === "GET") {
        if (_.isPlainObject(data)) {
          qs = data;
        } /*else if (data) {
                    console.warn(
                        'GoDaddy Warning: data is not an object and is not being used'
                    );
                }*/
      } else {
        body = data;
      }

      return await rp({
        method,
        url: `${this.apiUrl}/${url}`,
        headers: {
          authorization: this._authorization,
          "content-type": "application/json",
        },
        body,
        qs,
        json: true,
      });
    } catch (e) {
      const { error } = e;
      const message = (error && error.message) || e.message;

      const newError = new Error(message);
      _.assign(newError, error);
      throw newError;
    }
  }

  async listDomains() {
    const domains = [];

    for await (const domain of this.listDomainsGen()) {
      domains.push(domain);
    }

    return domains;
  }

  async *listDomainsGen() {
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

  getDomain(domain) {
    return this.request({
      url: `/v1/domains/${domain}`,
    });
  }

  getRecords(opts) {
    const { domain, type, name } = opts;

    let url = `/v1/domains/${domain}/records`;

    if (type && name) {
      url = `${url}/${type}/${name}`;
    }

    return this.request({ url });
  }

  replaceRecords(opts) {
    const { domain, type, name, records } = opts;

    let url = `/v1/domains/${domain}/records`;

    if (type && name) {
      url = `${url}/${type}/${name}`;
    }

    return this.request({ method: "PUT", url, data: records });
  }

  async getARecord(domain) {
    try {
      return (
        await this.getRecord({
          domain,
          type: "A",
          name: "@",
        })
      ).data;
    } catch (e) {}
  }

  async getRecord(opts) {
    const records = await this.getRecords(opts);

    if (records) {
      if (records.length > 1) {
        throw new Error("more than one record found");
      }

      return records[0];
    }
  }

  updateRecords({ domain, type, name, records }) {
    return this.request({
      url: `/v1/domains/${domain}/${type}/${name}`,
      method: "PATCH",
      data: records,
    });
  }

  updateNameServers({ domain, nameServers = [] }) {
    return this.request({
      url: `/v1/domains/${domain}`,
      method: "PATCH",
      data: { nameServers },
    });
  }

  getDomainAvailability({ domain, privacy }) {
    return this.request({
      url: "/v1/domains/available",
      data: { domain },
    }).then((data) => {
      if (_.isNumber(data.price)) {
        data.price /= 1000000;

        if (privacy) {
          data.price += this._privacyPrice;
        }
      }

      return data;
    });
  }

  getPurchaseSchema(domain) {
    const tld = this.getTld(domain);

    return this.request({
      url: `/v1/domains/purchase/schema/${tld}`,
    });
  }

  async purchaseDomain(opts) {
    let {
      domain,
      contact,
      contactAdmin = contact,
      contactBilling = contact,
      contactRegistrant = contact,
      contactTech = contact,
      buyingIp,
      privacy,
      force,
    } = opts || {};

    const { available, price } = await this.getDomainAvailability({
      domain,
      privacy,
    });

    if (!available) {
      throw new Error(`Domain "${domain}" not available for purchase`);
    }

    if (price > this.priceLimit && !force) {
      throw new Error(
        `Cannot purchase domain as it is more expensive than the price limit: $${
          this.priceLimit
        } (value: $${price.toFixed(2)})`
      );
    }

    const schema = await this.getPurchaseSchema(domain);
    if (
      privacy === false &&
      schema.required.findIndex((value) => value === "privacy") === -1
    ) {
      privacy = undefined;
    }

    const agreementKeys = await this.getAgreementKeys({ domain, privacy });

    if (!_.isString(buyingIp)) {
      buyingIp = await ipify({ useIPv6: false });
    }

    try {
      return await this.request({
        url: `/v1/domains/purchase`,
        method: "POST",
        data: _.pick(
          {
            ...opts,
            consent: {
              agreedAt: new Date().toISOString(),
              agreedBy: buyingIp,
              agreementKeys,
            },
            contactAdmin,
            contactBilling,
            contactRegistrant,
            contactTech,
            domain,
            privacy,
          },
          [...Object.keys(schema.properties), "privacy"]
        ),
      });
    } catch (e) {
      if (/Unable to authorize credit based/i.test(e.message)) {
        e.message = "Cannot purchase domain due to insufficient funds";
      }

      if (e.code === "INVALID_BODY") {
        e.message = "This domain requires more data for successful purchase";

        for (const field of e.fields) {
          const path = field.path.replace(/^(?:body\.)?(.+)$/, "$1");
          _.assign(field, { ...schema.properties[path], path });
        }
      }

      throw e;
    }
  }

  async getAgreementKeys(opts) {
    const { domain, privacy = false } = opts;

    if (!_.isBoolean(privacy)) {
      throw new Error("privacy needs to be a boolean");
    }

    const tld = this.getTld(domain);

    const agreement = await this.request({
      url: `/v1/domains/agreements`,
      data: {
        tlds: tld,
        // do not change. needs to be "true" or "false"
        privacy: String(privacy),
      },
    });

    return agreement.map((a) => a.agreementKey);
  }

  getTld(domain) {
    return domain.substring(domain.indexOf(".") + 1, domain.length);
  }
}

module.exports = GoDaddy;
