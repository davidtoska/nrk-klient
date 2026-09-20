import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenContributors, parseFirstAired, seriesIdFromHref } from "../../src/nrk-format";

describe("parseFirstAired", () => {
    it("reads the long format used on program pages and episodes", () => {
        // strings copied from real NRK responses
        assert.equal(parseFirstAired("NRK1 · mandag 11. desember 1995 kl. 00:00"), "1995-12-11");
        assert.equal(parseFirstAired("NRK Super · lørdag 1. august 2015 kl. 06:30"), "2015-08-01");
        assert.equal(parseFirstAired("NRK2 · søndag 22. mars 1998 kl. 17:55"), "1998-03-22");
    });

    it("reads the numeric format used on some episodes", () => {
        assert.equal(parseFirstAired("29.11.2019"), "2019-11-29");
        assert.equal(parseFirstAired("5.3.2001"), "2001-03-05");
    });

    it("understands every Norwegian month name", () => {
        const months = [
            "januar", "februar", "mars", "april", "mai", "juni",
            "juli", "august", "september", "oktober", "november", "desember",
        ];
        months.forEach((name, i) => {
            const mm = String(i + 1).padStart(2, "0");
            assert.equal(parseFirstAired(`NRK1 · onsdag 3. ${name} 1987 kl. 20:00`), `1987-${mm}-03`);
        });
    });

    it("returns null for text it cannot read", () => {
        for (const bad of ["", "kl. 00:00", "NRK1", "1. foo 2000", "31. februar 2020", "0.1.2000", "12.13.2000", "1. mai 1500"]) {
            assert.equal(parseFirstAired(bad), null, JSON.stringify(bad));
        }
        assert.equal(parseFirstAired(), null);
        assert.equal(parseFirstAired(null, undefined), null);
    });

    it("uses the first candidate that can be read", () => {
        assert.equal(parseFirstAired(undefined, "garbage", "29.11.2019", "1.1.2000"), "2019-11-29");
        assert.equal(
            parseFirstAired("NRK1 · mandag 11. desember 1995 kl. 00:00", "29.11.2019"),
            "1995-12-11",
        );
    });

    it("accepts a leap day only in a leap year", () => {
        assert.equal(parseFirstAired("29.2.2020"), "2020-02-29");
        assert.equal(parseFirstAired("29.2.2019"), null);
    });
});

describe("seriesIdFromHref", () => {
    it("takes the last path segment", () => {
        assert.equal(seriesIdFromHref("/tv/catalog/series/muhammad-ali"), "muhammad-ali");
        assert.equal(seriesIdFromHref("/tv/catalog/series/dagsrevyen/"), "dagsrevyen");
        assert.equal(seriesIdFromHref("/tv/catalog/series/x?foo=1#bar"), "x");
    });

    it("returns null for missing links", () => {
        for (const bad of [undefined, null, "", "/"]) {
            assert.equal(seriesIdFromHref(bad), null);
        }
    });
});

describe("flattenContributors", () => {
    it("flattens role groups into one list in NRK's order", () => {
        assert.deepEqual(
            flattenContributors([
                { role: "Programledere", name: ["Sveinung Åsali", "Sveinulf Henriksen"] },
                { role: "Artister/Utøvere", name: ["Roy-Frode Løvland"] },
            ]),
            [
                { name: "Sveinung Åsali", role: "Programledere" },
                { name: "Sveinulf Henriksen", role: "Programledere" },
                { name: "Roy-Frode Løvland", role: "Artister/Utøvere" },
            ],
        );
    });

    it("trims names, drops empty ones and copes with missing data", () => {
        assert.deepEqual(flattenContributors([{ role: "Medvirkende", name: [" Kari ", "", "  "] }]), [
            { name: "Kari", role: "Medvirkende" },
        ]);
        assert.deepEqual(flattenContributors(null), []);
        assert.deepEqual(flattenContributors(undefined), []);
        assert.deepEqual(flattenContributors([]), []);
    });
});
