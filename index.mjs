import * as cheerio from "cheerio";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import ejs from "ejs";
import neatCsv from "neat-csv";

dotenv.config();

const minimumDate = new Date("December 20, 2025");

function dateWithoutTime(date) {
    return new Date(date.toDateString());
}

async function fetchPrinceGeorgesCounty() {
    const [rssFeed, legistarJson] = (await Promise.all([
        axios.get("https://princegeorgescountymd.legistar.com/Feed.ashx?M=L&ID=27795052&GUID=c1bd1534-3207-4b69-8f82-47b5683f1dd9&Title=Prince+George%27s+County+Council+-+Legislation"),
        axios.get(
            `https://webapi.legistar.com/v1/princegeorgescountymd/matters?$top=1000&$filter=MatterIntroDate+ge+datetime'${minimumDate.getFullYear()}-${minimumDate.getMonth() + 1}-${minimumDate.getDate()}'`,
            {headers: {"Accept": "application/json"}},
        )
    ])).map(_ => _.data);
    const $ = cheerio.load(rssFeed, {xml: true});

    let idToLink = new Map();

    for (const item of $("item").toArray()) {
        idToLink.set($(item).children("title").text(), $(item).children("link").text());
    }

    if (legistarJson.length >= 900) {
        throw new Error("TODO: Add pagination");
    }

    let values = [];

    for (const matter of legistarJson) {
        const value = {
            jurisdiction: "Prince George's County",
            id: matter.MatterFile,
            description: matter.MatterTitle,
            link: idToLink.get(matter.MatterFile),
            category: matter.MatterTypeName,
            introductionDate: dateWithoutTime(new Date(matter.MatterIntroDate)),
        };
        if (value.introductionDate <= minimumDate) continue;
        // TODO: Do we want more? Planning things? Appointments?
        if (value.category !== "Council Bill" && value.category !== "Resolution") continue;
        if (!value.link) throw new Error("Missing link");
        values.push(value);
    }

    return values;
}

async function fetchMontomgeryCounty() {
    const overpaginatedPage = (await axios.get("https://apps.montgomerycountymd.gov/ccllims/RecordSearchPage?TopSearch=1&AllActionSearch=0&SearchType=0&RecordsPerPage=100000&PageIndex=0")).data;
    const $ = cheerio.load(overpaginatedPage, {});

    let values = [];

    for (const item of $("#MainContent_grdResultsList>tbody>tr:not(.gridviewPager)").toArray()) {
        const children = $(item).children();
        const id = $($(children[1]).children()[1]).text().trim();
        const value = {
            jurisdiction: "Montgomery County",
            id,
            description: $($(children[2]).children()[1]).text().trim(),
            link: "https://apps.montgomerycountymd.gov/ccllims/" + $($(children[1]).children()[1]).attr("href"),
            category: id.startsWith("Bill") ? "Bill" : (id.startsWith("Resolution") ? "Resolution" : "Unknown"),
            introductionDate: dateWithoutTime(new Date($($(children[5]).children()[1]).text())),
        };
        if ($($(children[5]).children()[1]).text().trim().length === 0) continue;
        if (value.introductionDate <= minimumDate) continue;
        values.push(value);
    }

    return values;
}

async function fetchDc() {
    // 2025-2026 (inclusive) period
    const billCategoryId = 1;
    const resolutionCategoryId = 6;
    const councilPeriodId = 26;
    
    const config = {
        headers: {
            Authorization: process.env.DC_API_KEY,
        }
    };

    const bulkData = (await Promise.all([
        axios.post(`https://lims.dccouncil.gov/api/v2/PublicData/BulkData/${billCategoryId}/${councilPeriodId}`, {}, config),
        axios.post(`https://lims.dccouncil.gov/api/v2/PublicData/BulkData/${resolutionCategoryId}/${councilPeriodId}`, {}, config),
    ])).flatMap(v => v.data);

    let values = [];

    for (const item of bulkData) {
        const value = {
            jurisdiction: "District of Columbia",
            id: item.legislationNumber,
            description: item.title,
            link: `https://lims.dccouncil.gov/Legislation/${item.legislationNumber}`,
            category: item.legislationCategory,
            introductionDate: dateWithoutTime(new Date(item.introductionDate)),
        };
        if (value.introductionDate <= minimumDate) continue;
        values.push(value);
    }

    return values;
}

async function fetchMaryland() {
    // TODO
    const session = "2026rs";
    const csv = await neatCsv((await axios.get(`https://mgaleg.maryland.gov/${session}/misc/billsmasterlist/BillMasterList.csv`)).data);
    
    let values = [];

    for (const item of csv) {
        let category;
        switch (item["Bill Number"].at(1)) {
            case "B":
                category = "Bill";
                break;
        
            case "J":
                category = "Joint Resolution";
                break;

            default:
                continue;
        }

        let firstReadingComponents = item["First Reading Date - House of Origin"].split("/").map(v => parseInt(v));

        const value = {
            jurisdiction: "Maryland",
            id: item["Bill Number"],
            description: item["Title"],
            link: `https://mgaleg.maryland.gov/mgawebsite/Legislation/Details/${item["Bill Number"]}?ys=2026RS#`,
            category,
            introductionDate: dateWithoutTime(new Date(firstReadingComponents[2], firstReadingComponents[0]-1, firstReadingComponents[1])),
        };
        if (value.introductionDate <= minimumDate) continue;
        values.push(value);
    }

    return values;
}

async function fetchAllAndSort() {
    const results = (await Promise.all([
        fetchPrinceGeorgesCounty(),
        fetchMontomgeryCounty(),
        fetchDc(),
        fetchMaryland(),
    ])).flat();
    
    results.sort((a, b) => 
        +a.introductionDate === +b.introductionDate ?
        a.description.localeCompare(b.description, undefined, {sensitivity: "base"}) :
        +b.introductionDate - +a.introductionDate
    );

    let dates = [];

    let date = null;
    let dateStart = 0;
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (+date !== +result.introductionDate) {
            if (date !== null) dates.push({date, start: dateStart, end: i});
            dateStart = i;
            date = result.introductionDate;
        }
    }
    if (date !== null) dates.push({date, start: dateStart, end: results.length});
    
    return {
        dates,
        results,
    };
}

// fs.writeFileSync("pol2.json", JSON.stringify(await fetchPrinceGeorgesCounty(), null, "\t"));

fs.writeFileSync("data.json", JSON.stringify(await fetchAllAndSort(), null, "\t"));

const data = JSON.parse(fs.readFileSync("data.json"));
fs.writeFileSync("summary.html", ejs.render(fs.readFileSync("summary.ejs").toString(), {
    data,
    htmlEntities(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}));
