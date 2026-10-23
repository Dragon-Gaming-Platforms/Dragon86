# What the image origin says

Target: `i.copy.sh/fs.json`

| scheme | user-agent | referer | status | content-type | length | CORS |
|---|---|---|---|---|---|---|
| https | dragon86 | none | **TypeError** | - | - | - |
| https | dragon86 | copy.sh | **200** | application/json | 5815708 | * |
| https | dragon86 | same-origin | **200** | application/json | 5815708 | * |
| https | chrome | none | **TypeError** | - | - | - |
| https | chrome | copy.sh | **200** | application/json | 5815708 | * |
| https | chrome | same-origin | **200** | application/json | 5815708 | * |
| https | safari-ios | none | **TypeError** | - | - | - |
| https | safari-ios | copy.sh | **200** | application/json | 5815708 | * |
| https | safari-ios | same-origin | **200** | application/json | 5815708 | * |
| https | curl | none | **TypeError** | - | - | - |
| https | curl | copy.sh | **200** | application/json | 5815708 | * |
| https | curl | same-origin | **200** | application/json | 5815708 | * |
| http | dragon86 | none | **TypeError** | - | - | - |
| http | dragon86 | copy.sh | **200** | application/json | 5815708 | * |
| http | dragon86 | same-origin | **200** | application/json | 5815708 | * |
| http | chrome | none | **TypeError** | - | - | - |
| http | chrome | copy.sh | **200** | application/json | 5815708 | * |
| http | chrome | same-origin | **200** | application/json | 5815708 | * |
| http | safari-ios | none | **TypeError** | - | - | - |
| http | safari-ios | copy.sh | **200** | application/json | 5815708 | * |
| http | safari-ios | same-origin | **200** | application/json | 5815708 | * |
| http | curl | none | **TypeError** | - | - | - |
| http | curl | copy.sh | **200** | application/json | 5815708 | * |
| http | curl | same-origin | **200** | application/json | 5815708 | * |

## First combination that works: `https` / UA `dragon86` / referer `copy.sh`

- final URL: `https://i.copy.sh/fs.json`
- content-type: `application/json`
- Access-Control-Allow-Origin: `*`
- first bytes: `{"fsroot":[["lib`

Response headers:

```
Date: Fri, 23 Oct 2026 19:19:22 GMT
Content-Type: application/json
Content-Length: 5815708
Connection: close
Vary: Accept-Encoding
Server: BunnyCDN-IL1-1068
CDN-PullZone: 165003
CDN-RequestCountryCode: US
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Server, x-goog-meta-frames, Content-Length, Content-Type, Range, X-Requested-With, If-Modified-Since, If-None-Match
Access-Control-Expose-Headers: Server, x-goog-meta-frames, Content-Length, Content-Type, Range, X-Requested-With, If-Modified-Since, If-None-Match
Cache-Control: public, max-age=43200
ETag: "6717277a-58bd9c"
Last-Modified: Tue, 22 Oct 2024 04:18:02 GMT
CDN-StorageServer: NY-346
CDN-FileServer: 749
CDN-ProxyVer: 1.71
CDN-RequestPullSuccess: True
CDN-RequestPullCode: 200
CDN-CachedAt: 10/23/2026 19:17:20
CDN-EdgeStorageId: 871
CDN-RequestId: 7f0a77498378c823c22fb4c0c0b07f6f
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
