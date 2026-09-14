/* SLGL Inbound Control Tower — static vanilla-JS port of app/page.tsx.
   Fetches ./data/slgl-data.json (built by scripts/build-dashboard-data.py)
   and renders the full dashboard client-side. No server required. */
(function () {
  "use strict";

  var tabs = ["Summary", "Bookings", "Inbound Status", "Origin", "Port Aging", "Shipment Search"];

  // Column-A "Status" values that mean "sitting at the destination port".
  var AT_PORT_STATUSES = ["POD Available", "POD Outgate", "POD Discharge", "Arrived POD"];

  var fmt = function (n) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n || 0); };
  var pct = function (n) { return Math.round((n || 0) * 100) + "%"; };
  var money = function (n) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0); };
  var sum = function (a, f) { return a.reduce(function (s, x) { return s + (f(x) || 0); }, 0); };
  var uniq = function (a) { return Array.from(new Set(a.filter(Boolean))).sort(); };
  var dateFmt = function (s) {
    if (!s) return "—";
    var d = new Date(s + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  };
  var dateFmtFull = function (s) {
    if (!s) return "—";
    var d = new Date(s + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };
  var lifecycle = function (x) {
    if (x.status === "Returned") return "Returned";
    if (x.status === "Empty") return "Empty";
    if (x.shipmentStatusType === "Active") return "Active / In Transit";
    return "Delivered / Completed";
  };

  function csvDownload(name, rows) {
    if (!rows.length) return;
    var h = Object.keys(rows[0]);
    var escc = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
    var body = [h.map(escc).join(",")].concat(rows.map(function (r) { return h.map(function (k) { return escc(r[k]); }).join(","); })).join("\n");
    var blob = new Blob([body], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  var state = {
    tab: "Summary", q: "", searchScope: "All",
    origin: "All", week: "All", bs: "All", dest: "All", status: "All", rate: "All",
    shipmentStatusDetail: [],
    swkDest: "GDC", swkFcl: "All",
  };

  var root = document.getElementById("slgl-root");
  var DATA = null;

  function pillClass(s) {
    s = s || "";
    if (s.indexOf("Pending") >= 0) return "warn";
    if (s.indexOf("Water") >= 0 || s.indexOf("Depart") >= 0) return "move";
    if (s.indexOf("POD") >= 0 || s.indexOf("Port") >= 0) return "port";
    return "";
  }
  function pillHtml(s) { return '<span class="pill ' + pillClass(s) + '">' + esc(s || "Unknown") + "</span>"; }

  function kpiHtml(l, v, d, t, clickable, extra) {
    t = t || "blue";
    var cls = "kpi " + t + (clickable ? " clickable" : "");
    return '<article class="' + cls + '"' + (clickable ? ' role="button" tabindex="0" data-action="' + esc(extra) + '"' : "") + ">" +
      "<p>" + esc(l) + "</p><strong>" + v + "</strong><span>" + d + "</span>" +
      (clickable ? "<em>View underlying data →</em>" : "") + "</article>";
  }

  function selHtml(label, value, options, name) {
    var html = '<label class="filter"><span>' + esc(label) + '</span><select data-filter="' + name + '">';
    html += '<option' + (value === "All" ? " selected" : "") + ">All</option>";
    options.forEach(function (o) { html += "<option" + (o === value ? " selected" : "") + ">" + esc(o) + "</option>"; });
    html += "</select></label>";
    return html;
  }

  // Multi-select slicer (checkbox list). Empty selection means "All".
  function selHtmlMulti(label, selected, options, name) {
    var html = '<label class="filter"><span>' + esc(label) + (selected.length ? " (" + selected.length + ")" : "") + '</span><div class="multiSelect" data-filter-multi="' + name + '">';
    html += options.map(function (o) {
      var checked = selected.indexOf(o) >= 0 ? " checked" : "";
      return '<label><input type="checkbox" value="' + esc(o) + '"' + checked + "> " + esc(o) + "</label>";
    }).join("");
    html += "</div></label>";
    return html;
  }

  function barsHtml(rows) {
    var m = Math.max.apply(null, rows.map(function (x) { return x.value; }).concat([1]));
    return '<div class="bars">' + rows.map(function (x) {
      return '<div class="barRow"><div><b>' + esc(x.label) + "</b><small>" + esc(x.sub) + "</small></div>" +
        '<i><em style="width:' + Math.max(1, (x.value / m) * 100) + '%"></em></i>' +
        "<strong>" + fmt(x.value) + "</strong></div>";
    }).join("") + "</div>";
  }

  function computeDerived() {
    var d = DATA;
    var origin = state.origin, week = state.week, bs = state.bs, dest = state.dest, status = state.status, rate = state.rate;
    var origins = uniq(d.bookings.map(function (x) { return x.origin; }).concat(d.activeContainers.map(function (x) { return x.origin; })));
    var weeks = uniq(d.bookings.map(function (x) { return String(x.crdWeek); }));
    var dests = uniq(d.bookings.map(function (x) { return x.destination; }).concat(d.activeContainers.map(function (x) { return x.destination; })));

    var ssDetail = state.shipmentStatusDetail || [];
    var containers = d.activeContainers.filter(function (x) {
      return (origin === "All" || x.origin === origin) && (status === "All" || x.status === status) && (dest === "All" || x.destination === dest) &&
        (ssDetail.length === 0 || ssDetail.indexOf(x.shipmentStatus) >= 0);
    });
    var onWater = containers.filter(function (x) { return x.status === "On Water"; });
    var port = containers.filter(function (x) { return AT_PORT_STATUSES.indexOf(x.status) >= 0; });
    var statMix = uniq(containers.map(function (x) { return x.status; })).map(function (s) {
      return { label: s, value: containers.filter(function (x) { return x.status === s; }).length, sub: fmt(sum(containers.filter(function (x) { return x.status === s; }), function (x) { return x.cartons; })) + " cartons / units" };
    }).sort(function (a, b) { return b.value - a.value; });
    var allOrigin = d.originDashboard.filter(function (x) { return x.origin === "All Origins"; })[0];
    var selectedOrigin = d.originDashboard.filter(function (x) { return x.origin === (origin === "All" ? "All Origins" : origin); })[0] || allOrigin;
    var orows = d.originDashboard.filter(function (x) { return x.origin !== "All Origins"; }).map(function (x) {
      var c = d.activeContainers.filter(function (y) { return y.origin === x.origin; });
      var t = x.total;
      return { o: x.origin, n: t.containerCount, co: t.spaceConfirmed, de: t.containersDeparted, pend: t.pendingSpace, cp: t.confirmedPct, dp: t.departedPct, days: t.avgDays, active: c.length, water: c.filter(function (y) { return y.status === "On Water"; }).length };
    });
    var searchBase = d.allContainers.filter(function (x) { return state.searchScope === "All" || lifecycle(x) === state.searchScope; });
    var q = state.q.trim().toLowerCase();
    var hits = q ? searchBase.filter(function (x) {
      return [x.container, x.flexId, x.mbl, x.hbl, x.po, x.shipment, x.origin, x.destination, x.shipper, x.carrier, x.containerLocation, x.status, x.shipmentStatus].some(function (v) {
        return (v || "").toLowerCase().indexOf(q) >= 0;
      });
    }).slice(0, 500) : [];

    return { origins: origins, weeks: weeks, dests: dests, containers: containers, onWater: onWater, port: port, statMix: statMix, allOrigin: allOrigin, selectedOrigin: selectedOrigin, orows: orows, searchBase: searchBase, hits: hits };
  }

  function originCsvRows(o, week) {
    var rows = week === "All" ? o.weeks : o.weeks.filter(function (x) { return String(x.crdWeek) === week; });
    return rows.map(function (x) {
      return { Origin: o.origin, "CRD Monday": x.crdDate, "CRD Week": x.crdWeek, "Container Count": x.containerCount, "Confirmed %": pct(x.confirmedPct), "Departed %": pct(x.departedPct), "Space Confirmed": x.spaceConfirmed, "Containers Departed": x.containersDeparted, "Pending Space": x.pendingSpace, "Pending Depart": x.pendingDepart, "Avg CRD-ETD": x.avgDays, "1-9 Days %": pct(x.bucket1to9), "10-14 Days %": pct(x.bucket10to14), "14-20 Days %": pct(x.bucket14to20), ">20 Days %": pct(x.bucketOver20) };
    });
  }
  function containerCsvRows(rows) {
    return rows.map(function (x) {
      return { Container: x.container, "FLEX-ID": x.flexId, Status: x.status, "Shipment Status": x.shipmentStatus, Origin: x.origin, POL: x.pol, POD: x.pod, POA: x.poa, Destination: x.destination, "Arrival ETA": x.arrivalEta, "Arrival ATA": x.arrivalAta, "Destination ETA": x.destinationEta, "Origin ATD": x.originAtd, Cartons: x.cartons, "Container Size": x.containerSize, "Current Location": x.containerLocation, Shipper: x.shipper, Carrier: x.carrier, PO: x.po, MBL: x.mbl, HBL: x.hbl, "CAN Rate": x.canRate, "Rate Type": x.rateType, "Transit Days": x.daysTransit };
    });
  }

  function filtersHtml(d) {
    var h = '<div class="filters">' + selHtml("Origin", state.origin, d.origins, "origin");
    if (state.tab === "Bookings") {
      h += selHtml("CRD Week", state.week, d.weeks, "week");
      h += selHtml("Booking Status", state.bs, uniq(DATA.bookings.map(function (x) { return x.status; })), "bs");
    }
    if (state.tab !== "Bookings") {
      h += selHtml("Status", state.status, uniq(DATA.activeContainers.map(function (x) { return x.status; })), "status");
      h += selHtml("Destination", state.dest, d.dests, "dest");
    }
    if (state.tab === "Inbound Status") {
      h += selHtmlMulti("Shipment Status Detail", state.shipmentStatusDetail || [], uniq(DATA.activeContainers.map(function (x) { return x.shipmentStatus; })), "shipmentStatusDetail");
    }
    h += "</div>";
    return h;
  }

  function kpisHtml(d) {
    return '<div class="kpis">' +
      kpiHtml("CRD CONFIRMED", pct(d.allOrigin.total.confirmedPct), fmt(d.allOrigin.total.spaceConfirmed) + " of " + fmt(d.allOrigin.total.containerCount) + " containers · Space Confirmed", "green", true, "gotoBookings") +
      kpiHtml("ON WATER VOLUME", fmt(d.onWater.length), fmt(sum(d.onWater, function (x) { return x.cartons; })) + " cartons / units", "blue", true, "gotoOnWater") +
      kpiHtml("AT PORT VOLUME", fmt(d.port.length), fmt(sum(d.port, function (x) { return x.cartons; })) + " cartons / units", "amber", true, "gotoInbound") +
      kpiHtml("PENDING SPACE", fmt(d.allOrigin.total.pendingSpace), fmt(d.allOrigin.total.containersDeparted) + " containers departed", "red", true, "gotoBookings") +
      "</div>";
  }

  function originWeekTableHtml(data, week) {
    var rows = week === "All" ? data.weeks : data.weeks.filter(function (x) { return String(x.crdWeek) === week; });
    var body = rows.map(function (x) {
      return '<tr class="' + (x.pendingSpace > 0 ? "riskrow" : "") + '"><td><b>' + dateFmt(x.crdDate) + "</b></td><td>W" + x.crdWeek + "</td><td>" + fmt(x.containerCount) + '</td><td><span class="meter"><i style="width:' + pct(x.confirmedPct) + '"></i></span><b>' + pct(x.confirmedPct) + "</b></td><td>" + pct(x.departedPct) + "</td><td>" + fmt(x.spaceConfirmed) + "</td><td>" + fmt(x.containersDeparted) + '</td><td class="' + (x.pendingSpace ? "bad" : "") + '">' + fmt(x.pendingSpace) + "</td><td>" + fmt(x.pendingDepart) + "</td><td>" + (x.avgDays ? x.avgDays.toFixed(0) + " days" : "—") + "</td><td>" + pct(x.bucket1to9) + "</td><td>" + pct(x.bucket10to14) + "</td><td>" + pct(x.bucket14to20) + "</td><td>" + pct(x.bucketOver20) + "</td></tr>";
    }).join("");
    if (week === "All") {
      var t = data.total;
      body += '<tr class="total"><td><b>Total</b></td><td>—</td><td>' + fmt(t.containerCount) + "</td><td><b>" + pct(t.confirmedPct) + "</b></td><td><b>" + pct(t.departedPct) + "</b></td><td>" + fmt(t.spaceConfirmed) + "</td><td>" + fmt(t.containersDeparted) + "</td><td>" + fmt(t.pendingSpace) + "</td><td>" + fmt(t.pendingDepart) + "</td><td>" + t.avgDays.toFixed(0) + " days</td><td>" + pct(t.bucket1to9) + "</td><td>" + pct(t.bucket10to14) + "</td><td>" + pct(t.bucket14to20) + "</td><td>" + pct(t.bucketOver20) + "</td></tr>";
    }
    return '<article class="panel weekly"><div class="ph"><div><span>WEEKLY BOOKING EXECUTION</span><h2>' + esc(data.origin) + ' — CRD readiness by week</h2></div><div class="actions"><div class="legend"><i></i>Confirmed <i></i>Pending</div><button class="download" data-action="downloadOriginWeek">↓ Download underlying data</button></div></div><div class="tw"><table><thead><tr><th>CRD Monday</th><th>CRD Week</th><th>Container Count</th><th>Confirmed %</th><th>Departed %</th><th>Space Confirmed</th><th>Containers Departed</th><th>Pending Space</th><th>Pending Depart</th><th>Avg CRD–ETD</th><th>1–9 Days</th><th>10–14 Days</th><th>14–20 Days</th><th>&gt;20 Days</th></tr></thead><tbody>' + body + "</tbody></table></div></article>";
  }

  function bookingsOriginTableHtml(rows) {
    var body = rows.map(function (x) {
      return '<tr><td><b>' + esc(x.o) + "</b></td><td>" + fmt(x.n) + '</td><td><span class="meter"><i style="width:' + pct(x.cp) + '"></i></span><b>' + pct(x.cp) + "</b></td><td>" + pct(x.dp) + "</td><td>" + fmt(x.co) + "</td><td>" + fmt(x.de) + '</td><td class="' + (x.pend ? "bad" : "") + '">' + fmt(x.pend) + "</td><td>" + fmt(Math.max(x.n - x.de, 0)) + "</td><td>" + (x.days ? x.days.toFixed(1) + " days" : "—") + "</td></tr>";
    }).join("");
    return '<article class="panel"><div class="ph"><div><span>ORIGIN DASHBOARD REPLICA</span><h2>All Origins Bookings Status</h2></div></div><div class="tw"><table><thead><tr><th>Origin</th><th>Containers</th><th>Confirmed %</th><th>Departed %</th><th>Confirmed</th><th>Departed</th><th>Pending Space</th><th>Pending Depart</th><th>Avg CRD–ETD</th></tr></thead><tbody>' + body + "</tbody></table></div></article>";
  }
  function weekSortKey(wk) {
    var parts = (wk || "").split(".");
    var m = parseInt(parts[0], 10), d = parseInt(parts[1], 10);
    return (isNaN(m) ? 99 : m) * 100 + (isNaN(d) ? 99 : d);
  }

  // Client-side rebuild of the workbook's own "Ct CANs" pivot (Status rows x
  // No Roll DC Wk columns), with slicers matching the pivot's own Filters
  // area (FCL/LCL, DEST) so it can be sliced the same way in Excel.
  // The source pivot's Status row field carries its own built-in filter
  // (separate from the FCL/LCL and DEST slicers in its Filters area) that
  // limits it to these 4 values - keep that fixed so the DEST/FCL slicers
  // reproduce the same pivot rather than opening up every lifecycle status.
  var STATUS_BY_WEEK_STATUSES = ["Delivered", "POD Available", "Arrived POD", "On Water"];

  function statusByWeekHtml() {
    var all = DATA.allContainers || [];
    var destOptions = uniq(all.map(function (x) { return x.destination; }));
    var fclOptions = uniq(all.map(function (x) { return x.fclLcl; }));
    var rows = all.filter(function (x) {
      return (state.swkDest === "All" || x.destination === state.swkDest) &&
        (state.swkFcl === "All" || x.fclLcl === state.swkFcl) &&
        STATUS_BY_WEEK_STATUSES.indexOf(x.status) >= 0;
    });
    var weeks = uniq(rows.map(function (x) { return x.dcWeek; }).filter(Boolean)).sort(function (a, b) { return weekSortKey(a) - weekSortKey(b); });
    var statusOrder = STATUS_BY_WEEK_STATUSES.map(function (s) {
      return { status: s, count: rows.filter(function (x) { return x.status === s; }).length };
    }).filter(function (s) { return s.count > 0; });

    var slicers = '<div class="filters">' +
      selHtml("DEST", state.swkDest, destOptions, "swkDest") +
      selHtml("FCL / LCL", state.swkFcl, fclOptions, "swkFcl") +
      "</div>";

    if (!statusOrder.length) {
      return '<article class="panel weekly"><div class="ph"><div><span>SOURCE WORKBOOK PIVOT</span><h2>Status by week (No Roll DC Wk)</h2></div></div>' + slicers + '<p style="padding:0 18px 16px;color:var(--muted);font-size:12px;">No rows match this filter combination.</p></article>';
    }

    var head = "<th>Status</th>" + weeks.map(function (w) { return "<th>" + esc(w) + "</th>"; }).join("") + "<th>Total</th>";
    var body = statusOrder.map(function (s) {
      var cells = weeks.map(function (w) {
        var n = rows.filter(function (x) { return x.status === s.status && x.dcWeek === w; }).length;
        return "<td>" + (n ? fmt(n) : "") + "</td>";
      }).join("");
      return "<tr><td><b>" + esc(s.status) + "</b></td>" + cells + "<td><b>" + fmt(s.count) + "</b></td></tr>";
    }).join("");
    var weekTotals = weeks.map(function (w) { return rows.filter(function (x) { return x.dcWeek === w; }).length; });
    var grandTotal = rows.length;
    var totalRow = "<tr class=\"total\"><td><b>Total</b></td>" +
      weekTotals.map(function (n) { return "<td>" + fmt(n) + "</td>"; }).join("") +
      "<td><b>" + fmt(grandTotal) + "</b></td></tr>";
    return '<article class="panel weekly"><div class="ph"><div><span>SOURCE WORKBOOK PIVOT</span><h2>Status by week (No Roll DC Wk)</h2></div></div>' + slicers + '<div class="tw"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + totalRow + "</tbody></table></div></article>";
  }

  function originDetailTableHtml(rows) {
    var body = rows.map(function (x) {
      return '<tr><td><b>' + esc(x.o) + "</b></td><td>" + fmt(x.n) + "</td><td>" + fmt(x.active) + "</td><td>" + fmt(x.water) + '</td><td><span class="meter"><i style="width:' + pct(x.cp) + '"></i></span><b>' + pct(x.cp) + "</b></td><td>" + pct(x.dp) + "</td><td>" + fmt(x.co) + "</td><td>" + fmt(x.de) + '</td><td class="' + (x.pend ? "bad" : "") + '">' + fmt(x.pend) + "</td><td>" + fmt(Math.max(x.n - x.de, 0)) + "</td><td>" + (x.days ? x.days.toFixed(1) + " days" : "—") + "</td></tr>";
    }).join("");
    return '<article class="panel"><div class="ph"><div><span>BUSINESS REVIEW</span><h2>Origin performance detail</h2></div></div><div class="tw"><table><thead><tr><th>Origin</th><th>Containers</th><th>Active</th><th>On Water</th><th>Confirmed %</th><th>Departed %</th><th>Confirmed</th><th>Departed</th><th>Pending Space</th><th>Pending Depart</th><th>Avg CRD–ETD</th></tr></thead><tbody>' + body + "</tbody></table></div></article>";
  }

  var tabIntro = {
    "Summary": "The operating picture: booking readiness, inbound volume and port exposure.",
    "Bookings": "All Origins Bookings Status — cargo readiness, confirmation and departure execution.",
    "Inbound Status": "Active inbound containers by current operational milestone.",
    "Origin": "Country-level booking and transit performance for weekly business review.",
    "Port Aging": "Containers currently sitting at the destination port, ranked by how many days each has been there since arrival — oldest first.",
    "Shipment Search": "Search container, FLEX-ID, MBL/HBL, PO, vendor, location or origin.",
  };

  function render() {
    var d = computeDerived();
    var tab = state.tab;
    var body = "";
    var sigmaLink = tab === "Summary"
      ? '<a class="download" href="https://app.sigmacomputing.com/serenaandlily/workbook/SLGL-Ops-Dashboard-6G7VTGgQ5kV1jAxI8dxPCI/edit?:nodeId=Ka-_vcCweE" target="_blank" rel="noopener">Sigma Daily View ↗</a>'
      : "";
    body += '<div class="title"><div><span>OPERATIONS / ' + tab.toUpperCase() + "</span><h1>" + esc(tab) + "</h1><p>" + esc(tabIntro[tab]) + '</p></div><div class="titleActions">' + sigmaLink + '<button class="download" data-action="downloadCurrent">↓ Download Current View</button><button data-action="print">Print / PDF</button></div></div>';

    if (tab === "Summary") {
      body += kpisHtml(d);
      body += '<div class="grid"><article class="panel"><div class="ph"><div><span>BOOKING READINESS</span><h2>All Origins Bookings Status</h2></div><button data-action="gotoBookings">View detail →</button></div>' +
        barsHtml(d.orows.slice(0, 7).map(function (x) { return { label: x.o, sub: pct(x.cp) + " confirmed · " + fmt(x.pend) + " pending", value: x.co }; })) +
        '</article><article class="panel"><div class="ph"><div><span>ACTIVE INBOUND</span><h2>Current Status Mix</h2></div><button data-action="gotoInbound">View detail →</button></div>' +
        barsHtml(d.statMix) + "</article></div>";
    } else if (tab === "Bookings") {
      body += filtersHtml(d) + kpisHtml(d) + originWeekTableHtml(d.selectedOrigin, state.week) + bookingsOriginTableHtml(d.orows);
    } else if (tab === "Inbound Status") {
      body += filtersHtml(d);
      body += '<div class="kpis">' +
        kpiHtml("ACTIVE CONTAINERS", fmt(d.containers.length), fmt(sum(d.containers, function (x) { return x.cartons; })) + " cartons / units", "blue", false) +
        kpiHtml("ON WATER", fmt(d.onWater.length), fmt(sum(d.onWater, function (x) { return x.cartons; })) + " cartons / units", "blue", false) +
        kpiHtml("AT PORT", fmt(d.port.length), fmt(sum(d.port, function (x) { return x.cartons; })) + " cartons / units", "amber", false) +
        kpiHtml("AVG TRANSIT", (sum(d.containers, function (x) { return x.daysTransit; }) / Math.max(d.containers.length, 1)).toFixed(1) + "d", "Current active population", "green", false) +
        "</div>";
      var nextArrivals = d.containers.filter(function (x) { return x.arrivalEta; }).sort(function (a, b) { return (a.arrivalEta || "").localeCompare(b.arrivalEta || ""); }).slice(0, 15);
      body += '<div class="grid"><article class="panel"><div class="ph"><div><span>CONTAINER + UNIT VOLUME</span><h2>Inbound Status</h2></div></div>' + barsHtml(d.statMix) + '</article><article class="panel"><div class="ph"><div><span>NEXT ARRIVALS</span><h2>Arrival Port ETA</h2></div></div><div class="tw"><table><thead><tr><th>Container</th><th>Status</th><th>Origin</th><th>ETA</th><th>Units</th></tr></thead><tbody>' +
        nextArrivals.map(function (x) { return "<tr><td><b>" + esc(x.container) + "</b></td><td>" + pillHtml(x.status) + "</td><td>" + esc(x.origin) + "</td><td>" + dateFmt(x.arrivalEta) + "</td><td>" + fmt(x.cartons) + "</td></tr>"; }).join("") +
        "</tbody></table></div></article></div>";
      body += statusByWeekHtml();
    } else if (tab === "Origin") {
      body += filtersHtml(d);
      body += '<div class="originCards">' + d.orows.map(function (x) {
        return '<button data-action="gotoOrigin" data-origin="' + esc(x.o) + '"><span>' + esc(x.o) + "</span><strong>" + fmt(x.n) + "</strong><small>containers</small><div><b>" + pct(x.cp) + "</b> confirmed</div><div><b>" + (x.days ? x.days.toFixed(1) : "—") + "d</b> CRD–ETD</div><i style=\"width:" + pct(x.cp) + '"></i></button>';
      }).join("") + "</div>";
      body += originDetailTableHtml(d.orows);
    } else if (tab === "Port Aging") {
      var pc = DATA.portContainers || [];
      var totalCartons = sum(pc, function (x) { return x.cartons; });
      var totalCbm = sum(pc, function (x) { return x.cbm; });
      var oldest = pc.length ? pc[0].daysAtPort : null;
      body += '<div class="kpis">' +
        kpiHtml("AT PORT NOW", fmt(pc.length), fmt(totalCartons) + " cartons / units", "amber", false) +
        kpiHtml("OLDEST DWELL", oldest == null ? "—" : oldest + "d", "Longest since port arrival", "red", false) +
        kpiHtml("TOTAL CBM", fmt(totalCbm), "Volume currently at port", "blue", false) +
        "</div>";
      body += '<article class="panel"><div class="ph"><div><span>OLDEST FIRST</span><h2>Days at port since arrival</h2></div></div><div class="tw"><table><thead><tr><th>Container</th><th>Origin</th><th>Status</th><th>Port Arrival</th><th>Days at Port</th><th>Cartons / Units</th><th>CBM</th></tr></thead><tbody>' +
        pc.map(function (x) {
          var days = x.daysAtPort == null ? "—" : x.daysAtPort + "d";
          return "<tr><td><b>" + esc(x.container) + "</b></td><td>" + esc(x.origin) + "</td><td>" + pillHtml(x.status) + "</td><td>" + (x.arrivalDate ? dateFmt(x.arrivalDate) + (x.arrivalIsEstimate ? " (est.)" : "") : "—") + "</td><td class=\"" + (x.daysAtPort >= 14 ? "bad" : "") + "\">" + days + "</td><td>" + fmt(x.cartons) + "</td><td>" + fmt(x.cbm) + "</td></tr>";
        }).join("") +
        "</tbody></table></div></article>";
    } else if (tab === "Shipment Search") {
      body += '<div class="search"><span>SMART SEARCH</span><h2>Find any container or shipment record</h2><p>Search active, delivered, returned and empty records by Container #, PO #, FLEX-ID, MBL/HBL, vendor, lane or location.</p>' +
        '<label class="searchScope"><span>Lifecycle</span><select data-filter="searchScope">' +
        ["All", "Active / In Transit", "Delivered / Completed", "Returned", "Empty"].map(function (x) { return "<option" + (x === state.searchScope ? " selected" : "") + ">" + x + "</option>"; }).join("") +
        '</select></label><div><b>⌕</b><input autofocus data-input="q" value="' + esc(state.q) + '" placeholder="Try CAAU, FLEX-394, 10891319, Vietnam…"/><kbd>' + fmt(d.searchBase.length) + " searchable records</kbd></div></div>";
      if (state.q.trim()) {
        body += '<article class="panel"><div class="ph"><div><span>' + d.hits.length + ' MATCHES</span><h2>Search results</h2></div></div><div class="tw"><table><thead><tr><th>Container / FLEX-ID</th><th>Status</th><th>Lane</th><th>ETA</th><th>PO / MBL</th><th>Shipper</th><th>Units</th></tr></thead><tbody>' +
          d.hits.map(function (x) {
            return "<tr><td><b>" + esc(x.container) + "</b><small>" + esc(x.flexId) + "</small></td><td>" + pillHtml(x.status) + "<small>" + esc(lifecycle(x)) + " · " + esc(x.shipmentStatus) + "</small></td><td>" + esc(x.origin) + " → " + esc(x.destination) + "</td><td>" + dateFmt(x.arrivalEta) + "</td><td><b>" + esc(x.po || "—") + "</b><small>" + esc(x.mbl) + "</small></td><td>" + esc(x.shipper || "—") + "</td><td>" + fmt(x.cartons) + "</td></tr>";
          }).join("") +
          "</tbody></table></div></article>";
      }
    }

    root.querySelector(".content").innerHTML = body;
    bindContentEvents(d);
  }

  function bindContentEvents(d) {
    var content = root.querySelector(".content");
    content.querySelectorAll("[data-filter]").forEach(function (el) {
      el.addEventListener("change", function () { state[el.getAttribute("data-filter")] = el.value; render(); });
    });
    content.querySelectorAll("[data-filter-multi]").forEach(function (box) {
      var name = box.getAttribute("data-filter-multi");
      box.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var checked = Array.from(box.querySelectorAll("input[type=checkbox]:checked")).map(function (c) { return c.value; });
          state[name] = checked;
          render();
        });
      });
    });
    content.querySelectorAll("[data-input='q']").forEach(function (el) {
      el.addEventListener("input", function () { state.q = el.value; render(); });
      el.focus();
      var v = el.value; el.value = ""; el.value = v;
    });
    content.querySelectorAll("[data-action]").forEach(function (el) {
      el.addEventListener("click", function () {
        var action = el.getAttribute("data-action");
        if (action === "gotoBookings") { state.origin = "All"; state.week = "All"; state.tab = "Bookings"; }
        else if (action === "gotoOnWater") { state.status = "On Water"; state.tab = "Inbound Status"; }
        else if (action === "gotoInbound") { state.status = "All"; state.tab = "Inbound Status"; }
        else if (action === "gotoOrigin") { state.origin = el.getAttribute("data-origin"); state.tab = "Bookings"; }
        else if (action === "print") { window.print(); return; }
        else if (action === "downloadOriginWeek") {
          csvDownload("crd-confirmed-" + d.selectedOrigin.origin.toLowerCase().replace(/ /g, "-") + ".csv", originCsvRows(d.selectedOrigin, state.week));
          return;
        } else if (action === "downloadCurrent") {
          if (state.tab === "Summary") csvDownload("summary-kpi-underlying.csv", originCsvRows(d.allOrigin, "All"));
          else if (state.tab === "Bookings") csvDownload("bookings-" + d.selectedOrigin.origin.toLowerCase().replace(/ /g, "-") + ".csv", originCsvRows(d.selectedOrigin, state.week));
          else if (state.tab === "Inbound Status") csvDownload("inbound-status-filtered.csv", containerCsvRows(d.containers));
          else if (state.tab === "Origin") csvDownload("origin-performance.csv", d.orows.map(function (x) { return { Origin: x.o, Containers: x.n, "Space Confirmed": x.co, "Confirmed %": pct(x.cp), "Containers Departed": x.de, "Departed %": pct(x.dp), "Pending Space": x.pend, "Pending Depart": Math.max(x.n - x.de, 0), "Avg CRD-ETD": x.days, "Active Containers": x.active, "On Water": x.water }; }));
          else if (state.tab === "Port Aging") csvDownload("port-aging.csv", (DATA.portContainers || []).map(function (x) {
            return { Container: x.container, Origin: x.origin, Status: x.status, "Port Arrival": x.arrivalDate, "Estimate Only": x.arrivalIsEstimate, "Days At Port": x.daysAtPort, Cartons: x.cartons, CBM: x.cbm };
          }));
          else csvDownload("shipment-search-results.csv", containerCsvRows(d.hits));
          return;
        }
        render();
      });
    });
  }

  function renderShell() {
    var nav = tabs.map(function (t) { return '<button class="' + (state.tab === t ? "active" : "") + '" data-tab="' + t + '">' + t + "</button>"; }).join("");
    root.innerHTML =
      '<header><div class="brand"><b class="wordmark">SERENA &amp; LILY</b><div><strong>Inbound Control Tower</strong><span>Global Logistics · Daily / Weekly Visibility</span></div></div><div class="asof"><span>DATA AS OF</span><b>' + dateFmtFull(DATA.asOf).toUpperCase() + "</b></div></header>" +
      '<div class="shell"><aside><nav>' + nav + '</nav></aside><section class="content"></section></div>';
    root.querySelectorAll("nav button").forEach(function (b) {
      b.addEventListener("click", function () { state.tab = b.getAttribute("data-tab"); renderShell(); render(); });
    });
    render();
  }

  fetch("./data/slgl-data.json")
    .then(function (r) { return r.json(); })
    .then(function (data) { DATA = data; renderShell(); })
    .catch(function (err) {
      root.innerHTML = '<main class="loading">Could not load dashboard data (' + esc(err.message) + '). Check that data/slgl-data.json exists.</main>';
    });
})();
