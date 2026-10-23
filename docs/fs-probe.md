# What the image origin says

Target: `i.copy.sh/fs.json`

| scheme | user-agent | referer | status | content-type | length | CORS |
|---|---|---|---|---|---|---|
| https | dragon86 | none | **TypeError** | - | - | - |
| https | dragon86 | copy.sh | **200** | application/json | 5815708 | * |
| https | dragon86 | same-origin | **200** | application/json | 5815708 | * |
| https | dragon86 | our-pages | **403** | text/html | 2334 | - |
| https | dragon86 | random-site | **403** | text/html | 2334 | - |
| https | chrome | none | **TypeError** | - | - | - |
| https | chrome | copy.sh | **200** | application/json | 5815708 | * |
| https | chrome | same-origin | **200** | application/json | 5815708 | * |
| https | chrome | our-pages | **403** | text/html | 2334 | - |
| https | chrome | random-site | **403** | text/html | 2334 | - |
| https | safari-ios | none | **TypeError** | - | - | - |
| https | safari-ios | copy.sh | **200** | application/json | 5815708 | * |
| https | safari-ios | same-origin | **200** | application/json | 5815708 | * |
| https | safari-ios | our-pages | **403** | text/html | 2334 | - |
| https | safari-ios | random-site | **403** | text/html | 2334 | - |
| https | curl | none | **TypeError** | - | - | - |
| https | curl | copy.sh | **200** | application/json | 5815708 | * |
| https | curl | same-origin | **200** | application/json | 5815708 | * |
| https | curl | our-pages | **403** | text/html | 2334 | - |
| https | curl | random-site | **403** | text/html | 2334 | - |
| http | dragon86 | none | **TypeError** | - | - | - |
| http | dragon86 | copy.sh | **200** | application/json | 5815708 | * |
| http | dragon86 | same-origin | **200** | application/json | 5815708 | * |
| http | dragon86 | our-pages | **403** | text/html | 2334 | - |
| http | dragon86 | random-site | **403** | text/html | 2334 | - |
| http | chrome | none | **TypeError** | - | - | - |
| http | chrome | copy.sh | **200** | application/json | 5815708 | * |
| http | chrome | same-origin | **200** | application/json | 5815708 | * |
| http | chrome | our-pages | **403** | text/html | 2334 | - |
| http | chrome | random-site | **403** | text/html | 2334 | - |
| http | safari-ios | none | **TypeError** | - | - | - |
| http | safari-ios | copy.sh | **200** | application/json | 5815708 | * |
| http | safari-ios | same-origin | **200** | application/json | 5815708 | * |
| http | safari-ios | our-pages | **403** | text/html | 2334 | - |
| http | safari-ios | random-site | **403** | text/html | 2334 | - |
| http | curl | none | **TypeError** | - | - | - |
| http | curl | copy.sh | **200** | application/json | 5815708 | * |
| http | curl | same-origin | **200** | application/json | 5815708 | * |
| http | curl | our-pages | **403** | text/html | 2334 | - |
| http | curl | random-site | **403** | text/html | 2334 | - |

## First combination that works: `https` / UA `dragon86` / referer `copy.sh`

- final URL: `https://i.copy.sh/fs.json`
- content-type: `application/json`
- Access-Control-Allow-Origin: `*`
- first bytes: `{"fsroot":[["lib`

Response headers:

```
Date: Fri, 23 Oct 2026 19:52:39 GMT
Content-Type: application/json
Content-Length: 5815708
Connection: close
Vary: Accept-Encoding
Server: BunnyCDN-LA1-852
CDN-PullZone: 165003
CDN-RequestCountryCode: US
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Server, x-goog-meta-frames, Content-Length, Content-Type, Range, X-Requested-With, If-Modified-Since, If-None-Match
Access-Control-Expose-Headers: Server, x-goog-meta-frames, Content-Length, Content-Type, Range, X-Requested-With, If-Modified-Since, If-None-Match
Cache-Control: public, max-age=43200
ETag: "6717277a-58bd9c"
Last-Modified: Tue, 22 Oct 2024 04:18:02 GMT
CDN-StorageServer: LA-1053
CDN-FileServer: 828
CDN-ProxyVer: 1.71
CDN-RequestPullSuccess: True
CDN-RequestPullCode: 200
CDN-CachedAt: 10/23/2026 19:07:28
CDN-EdgeStorageId: 1109
CDN-RequestId: ae0005d1fbd35b3f690a51f50d87adcd
CDN-Cache: HIT
CDN-Status: 200
CDN-RequestTime: 0
Accept-Ranges: bytes
```

## Variations on the working shape

| variation | status |
|---|---|
| HEAD | **200** |
| cache-buster query | **200** |
| Accept: application/json | **200** |

## The vendored mirror (`arch-image` branch)

- base: `https://raw.githubusercontent.com/Dragon-Gaming-Platforms/Dragon86/arch-image/`
- manifest.json: **failed** — NameError: `name 'HEADERS' is not defined`

## The vendor workflow's own fetch (`mirror.py`)

- base: `https://i.copy.sh/`
- fs.json: **5815708 bytes**
- fsroot entries: 18
- smallest blob `e3b0c442.bin`: **0 bytes** (listed size 0)
