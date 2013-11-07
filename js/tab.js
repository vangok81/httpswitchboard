/*******************************************************************************

    httpswitchboard - a Chromium browser extension to black/white list requests.
    Copyright (C) 2013  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/httpswitchboard
*/

/******************************************************************************/

RequestStatsEntry.prototype.junkyard = [];

RequestStatsEntry.prototype.factory = function() {
    var entry = RequestStatsEntry.prototype.junkyard.pop();
    if ( entry ) {
        return entry;
    }
    return new RequestStatsEntry();
};

RequestStatsEntry.prototype.dispose = function() {
    // Let's not grab and hold onto too much memory..
    if ( RequestStatsEntry.prototype.junkyard.length < 200 ) {
        RequestStatsEntry.prototype.junkyard.push(this);
    }
};

/******************************************************************************/

PageStatsEntry.prototype.junkyard = [];

PageStatsEntry.prototype.factory = function(pageUrl) {
    var entry = PageStatsEntry.prototype.junkyard.pop();
    if ( entry ) {
        return entry.init(pageUrl);
    }
    return new PageStatsEntry(pageUrl);
};

/******************************************************************************/

PageStatsEntry.prototype.init = function(pageUrl) {
    this.pageUrl = pageUrl;
    this.requests = {};
    this.domains = {};
    this.state = {};
    this.requestStats.reset();
    this.distinctRequestCount = 0;
    this.perLoadAllowedRequestCount = 0;
    this.perLoadBlockedRequestCount = 0;
    this.greenSize = undefined;
    this.ignore = HTTPSB.excludeRegex.test(pageUrl);
    return this;
};

/******************************************************************************/

PageStatsEntry.prototype.dispose = function() {
    // Iterate through all requests and return them to the junkyard for
    // later reuse.
    var reqKeys = Object.keys(this.requests);
    var i = reqKeys.length;
    var reqKey;
    while ( i-- ) {
        reqKey = reqKeys[i];
        this.requests[reqKey].dispose();
        delete this.requests[reqKey];
    }
    PageStatsEntry.prototype.junkyard.push(this);
};

/******************************************************************************/

PageStatsEntry.prototype.recordRequest = function(type, url, block) {
    if ( !this ) {
        // console.error('HTTP Switchboard > PageStatsEntry.recordRequest() > no pageStats');
        return;
    }

    // rhill 2013-10-26: This needs to be called even if the request is
    // already logged, since the request stats are cached for a while after the
    // page is no longer in the browser.
    updateBadge(this.pageUrl);

    var hostname = getHostnameFromURL(url);

    // remember this blacklisting, used to create a snapshot of the state
    // of the page, which is useful for smart reload of the page (reload the
    // page only when permissions effectively change)
    if ( block ) {
        this.state[type +  '|' + hostname] = true;
    }

    // Count blocked/allowed requests
    this.requestStats.record(type, block);

    if ( block ) {
        this.perLoadBlockedRequestCount++;
    } else {
        this.perLoadAllowedRequestCount++;
    }
    // var packedUrl = urlPacker.remember(url) + '#' + type;

    var reqKey = url + '#' + type;
    var requestStatsEntry = this.requests[reqKey];
    if ( requestStatsEntry ) {
        requestStatsEntry.when = Date.now();
        requestStatsEntry.blocked = block;
        return;
    }

    requestStatsEntry = RequestStatsEntry.prototype.factory();
    requestStatsEntry.when = Date.now();
    requestStatsEntry.blocked = block;
    this.requests[reqKey] = requestStatsEntry;

    this.distinctRequestCount++;
    this.domains[hostname] = true;

    urlStatsChanged(this.pageUrl);
    // console.debug("HTTP Switchboard > PageStatsEntry.recordRequest() > %o: %s @ %s", this, type, url);
};

/******************************************************************************/

PageStatsEntry.prototype.getPageURL = function() {
    if ( !this ) {
        return undefined;
    }
    return this.pageUrl;
};

/******************************************************************************/

PageStatsEntry.prototype.setIcon = function(canvas) {
    this.icon = canvas;
};

/******************************************************************************/

// Generate image data which reflect internal state

PageStatsEntry.prototype.computeIcon = function(original) {
    if ( !this.icon ) {
        this.icon = cloneCanvas(original);
    }
    var squareSize = this.icon.width;
    var squareArea = squareSize * squareSize;
    var context = this.icon.getContext('2d');
    var total = this.perLoadAllowedRequestCount + this.perLoadBlockedRequestCount;
    var greenSize;
    if ( total ) {
        greenSize = Math.sqrt(squareArea * this.perLoadAllowedRequestCount / total);
        greenSize = greenSize < squareArea/2 ? Math.ceil(greenSize) : Math.floor(greenSize);
    }
    if ( greenSize !== this.iconGreenSize ) {
        if ( total ) {
            context.globalAlpha = 1.0;
            context.fillStyle = '#F44';
            context.fillRect(0, 0, squareSize, squareSize);
            if ( greenSize ) {
                context.fillStyle = '#0F0';
                context.fillRect(0, 0, greenSize, greenSize);
            }
            context.globalAlpha = 0.6;
            context.drawImage(original, 0, 0);
        } else {
            context.globalAlpha = 1.0;
            context.drawImage(original, 0, 0);
        }
        this.iconGreenSize = greenSize;
    }
    return context.getImageData(0, 0, squareSize, squareSize);
}

/******************************************************************************/

// Garbage collect stale url stats entries
// rhill 2013-10-23: revised to avoid closures.

function garbageCollectStalePageStatsWithNoTabsCallback(tabs) {
    var httpsb = HTTPSB;
    var visibleTabs = {};
    tabs.map(function(tab) {
        visibleTabs[tab.id] = true;
    });
    var pageUrls = Object.keys(httpsb.pageStats);
    var i = pageUrls.length;
    var pageUrl, tabId, pageStats;
    while ( i-- ) {
        pageUrl = pageUrls[i];
        // Do not dispose of chromium-behind-the-scene virtual tab,
        // GC is done differently on this one (i.e. just pruning).
        if ( pageUrl === httpsb.behindTheSceneURL ) {
            continue;
        }
        tabId = tabIdFromPageUrl(pageUrl);
        pageStats = httpsb.pageStats[pageUrl];
        if ( !visibleTabs[tabId] && !pageStats.visible ) {
            cookieHunter.erase(pageStats);
            httpsb.pageStats[pageUrl].dispose();
            delete httpsb.pageStats[pageUrl];
            // console.debug('HTTP Switchboard > GC: disposed of "%s"', pageUrl);
        }
        pageStats.visible = !!visibleTabs[tabId];
        if ( !pageStats.visible ) {
            unbindTabFromPageStats(tabId);
        }
    }
}

function garbageCollectStalePageStatsCallback() {
    var httpsb = HTTPSB;

    // Get rid of stale pageStats, those not bound to a tab for more than
    // {duration placeholder}.
    chrome.tabs.query({ 'url': '<all_urls>' }, garbageCollectStalePageStatsWithNoTabsCallback);

    // Prune content of chromium-behind-the-scene virtual tab
    var pageStats = httpsb.pageStats[httpsb.behindTheSceneURL];
    if ( pageStats ) {
        var reqKeys = Object.keys(pageStats.requests);
        if ( reqKeys > httpsb.behindTheSceneMaxReq ) {
            reqKeys = reqKeys.sort(function(a,b){
                var ra = pageStats.requests[a];
                var rb = pageStats.requests[b];
                if ( rb.when < ra.when ) { return -1; }
                if ( ra.when < rb.when ) { return 1; }
                return 0;
            }).slice(httpsb.behindTheSceneMaxReq);
            var iReqKey = reqKeys.length;
            var reqKey;
            while ( iReqKey-- ) {
                reqKey = reqKeys[iReqKey];
                pageStats.requests[reqKey].dispose();
                delete pageStats.requests[reqKey];
            }
        }
    }
}

// Time somewhat arbitrary: If a web page has not been in a tab for 10 minutes,
// flush its stats.
//                                                                          min  sec  1-sec
asyncJobQueue.add('gcPageStats', null, garbageCollectStalePageStatsCallback, 10 * 60 * 1000, true);

/******************************************************************************/

// Check if a page url stats store exists

function pageStatsExists(pageUrl) {
    return !!pageStatsFromPageUrl(pageUrl);
}

/******************************************************************************/

// Create a new page url stats store (if not already present)

function createPageStats(pageUrl) {
    // do not create stats store for urls which are of no interest
    if ( pageUrl.search(/^https?:\/\//) !== 0 ) {
        return undefined;
    }
    var httpsb = HTTPSB;
    var pageStats = httpsb.pageStats[pageUrl];
    if ( !pageStats ) {
        pageStats = PageStatsEntry.prototype.factory(pageUrl);
        httpsb.pageStats[pageUrl] = pageStats;
    }
    return pageStats;
}

/******************************************************************************/

// Create an entry for the tab if it doesn't exist

function bindTabToPageStats(tabId, pageUrl) {
    var pageStats = createPageStats(pageUrl);
    if ( !pageStats ) {
        return undefined;
    }
    // console.debug('bindTabToPageStats > dispatching traffic in tab id %d to url stats store "%s"', tabId, pageUrl);
    unbindTabFromPageStats(tabId);
    HTTPSB.pageUrlToTabId[pageUrl] = tabId;
    HTTPSB.tabIdToPageUrl[tabId] = pageUrl;
    return pageStats;
}

function unbindTabFromPageStats(tabId) {
    var httpsb = HTTPSB;
    var pageUrl = httpsb.tabIdToPageUrl[tabId];
    if ( pageUrl ) {
        delete httpsb.pageUrlToTabId[pageUrl];
    }
    delete httpsb.tabIdToPageUrl[tabId];
}

/******************************************************************************/

function urlFromReqKey(reqKey) {
    return reqKey.slice(0, reqKey.indexOf('#'));
}

function typeFromReqKey(reqKey) {
    return reqKey.slice(reqKey.indexOf('#') + 1);
}

/******************************************************************************/

// Log a request

function recordFromTabId(tabId, type, url, blocked) {
    var pageStats = pageStatsFromTabId(tabId);
    if ( pageStats ) {
        pageStats.recordRequest(type, url, blocked);
    }
}

function recordFromPageUrl(pageUrl, type, url, blocked) {
    var pageStats = pageStatsFromPageUrl(pageUrl);
    if ( pageStats ) {
        pageStats.recordRequest(type, url, blocked);
    }
}

/******************************************************************************/

// Reload content of a tabs.
// rhill 2013-10-23: revised to avoid closures.

function smartReloadExistingTabsCallback(chromeTabs) {
    var tabId;
    var i = chromeTabs.length;
    while ( i-- ) {
        tabId = chromeTabs[i].id;
        if ( tabExists(tabId) ) {
            smartReloadTab(tabId);
        }
    }
}

function smartReloadTabsCallback() {
    chrome.tabs.query({ status: 'complete' }, smartReloadExistingTabsCallback);
}

function smartReloadTabs() {
    asyncJobQueue.add('smartReloadTabs', null, smartReloadTabsCallback, 250);
}

/******************************************************************************/

// reload content of a tab

function smartReloadTab(tabId) {
    var newState = computeTabState(tabId);
    var pageUrl = pageUrlFromTabId(tabId);
    if ( !pageUrl ) {
        //console.error('HTTP Switchboard > smartReloadTab > page url for tab id %d not found', tabId);
        return;
    }
    var pageStats = pageStatsFromTabId(tabId);
    if ( !pageStats ) {
        //console.error('HTTP Switchboard > smartReloadTab > page stats for tab id %d not found', tabId);
        return;
    }
    if ( getStateHash(newState) != getStateHash(pageStats.state) ) {
        // console.debug('reloaded content of tab id %d', tabId);
        // console.debug('old="%s"\nnew="%s"', getStateHash(pageStats.state), getStateHash(newState));
        pageStats.state = newState;
        chrome.tabs.reload(tabId);
    }
}

/******************************************************************************/

// Required since not all tabs are of interests to HTTP Switchboard.
// Examples:
//      `chrome://extensions/`
//      `chrome-devtools://devtools/devtools.html`
//      etc.

function tabExists(tabId) {
    return !!pageUrlFromTabId(tabId);
}

/******************************************************************************/

function getTabStateHash(tabId) {
    var pageStats = pageStatsFromTabId(tabId);
    if ( pageStats ) {
        return getStateHash(pageStats.state);
    }
    console.error('HTTP Switchboard > getTabStateHash > page stats for tab id %d not found', tabId);
    return '';
}

/******************************************************************************/

function getStateHash(state) {
    var keys = Object.keys(state);
    if ( !keys.length ) {
        return '';
    }
    keys.sort();
    return keys.join();
}

/******************************************************************************/

function computeTabState(tabId) {
    var pageStats = pageStatsFromTabId(tabId);
    if ( !pageStats ) {
        //console.error('HTTP Switchboard > computeTabState > page stats for tab id %d not found', tabId);
        return {};
    }
    // Go through all recorded requests, apply filters to create state
    // It is a critical error for a tab to not be defined here
    var httpsb = HTTPSB;
    var computedState = {};
    var url, domain, type;
    for ( var reqKey in pageStats.requests ) {
        url = urlFromReqKey(reqKey);
        domain = getHostnameFromURL(url);
        type = typeFromReqKey(reqKey);
        if ( httpsb.blacklisted(pageUrlFromPageStats(pageStats), type, domain) ) {
            computedState[type +  '|' + domain] = true;
        }
    }
    return computedState;
}

/******************************************************************************/

function tabStateChanged(tabId) {
    var pageStats = pageStatsFromTabId(tabId);
    if ( pageStats ) {
        return getStateHash(computeTabState(tabId)) != getStateHash(pageStats.state);
    }
    console.error('HTTP Switchboard > tabStateChanged > page stats for tab id %d not found', tabId);
    return false;
}

/******************************************************************************/

function tabIdFromPageUrl(pageUrl) {
    return HTTPSB.pageUrlToTabId[pageUrl];
}

function tabIdFromPageStats(pageStats) {
    return tabIdFromPageUrl(pageStats.pageUrl);
}

function pageUrlFromTabId(tabId) {
    return HTTPSB.tabIdToPageUrl[tabId];
}

function pageUrlFromPageStats(pageStats) {
    if ( pageStats ) {
        return pageStats.getPageURL();
    }
    return undefined;
}

function pageStatsFromTabId(tabId) {
    var pageUrl = HTTPSB.tabIdToPageUrl[tabId];
    if ( pageUrl ) {
        return HTTPSB.pageStats[pageUrl];
    }
    return undefined;
}

function pageStatsFromPageUrl(pageUrl) {
    return HTTPSB.pageStats[pageUrl];
}

