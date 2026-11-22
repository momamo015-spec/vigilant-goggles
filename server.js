const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'text/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

/**
 * دالة استخراج وتنسيق عناصر lockupViewModel الجديدة
 */
function parseLockupItem(lockup) {
    const contentType = lockup.contentType || '';
    const id = lockup.contentId || '';
    const title = lockup.metadata?.lockupMetadataViewModel?.title?.content || '';
    
    // المؤلف والبيانات الوصفية
    const metaRows = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    let author = '';
    let badgeText = '';
    let viewCount = '';

    for (const row of metaRows) {
        for (const part of (row.metadataParts || [])) {
            const txt = part.text?.content || '';
            if (!author && txt && !txt.includes('فيديو') && !txt.includes('مشاهدة') && !txt.includes('قائمة')) {
                author = txt;
            } else if (txt.includes('فيديو') || txt.includes('مشترك')) {
                badgeText = txt;
            } else if (txt.includes('مشاهدة') || txt.includes('views')) {
                viewCount = txt;
            }
        }
    }

    // الصورة المصغرة
    let thumbnail = '';
    const thumbSources = lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources 
        || lockup.contentImage?.thumbnailViewModel?.image?.sources || [];
    if (thumbSources.length > 0) {
        thumbnail = thumbSources[thumbSources.length - 1].url;
    }

    if (contentType.includes('PLAYLIST')) {
        return {
            type: 'playlist',
            id,
            title,
            author: author || 'قائمة يوتيوب',
            thumbnail: thumbnail || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
            videoCount: badgeText || 'قائمة تشغيل'
        };
    } else if (contentType.includes('CHANNEL')) {
        return {
            type: 'channel',
            id,
            title,
            thumbnail,
            subscriberCount: badgeText || ''
        };
    } else {
        // افتراض فيديو
        return {
            type: 'video',
            id,
            title,
            author: author || 'يوتيوب',
            thumbnail: thumbnail || `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
            duration: badgeText || '',
            views: viewCount || ''
        };
    }
}

/**
 * جلب نتائج البحث من يوتيوب وتصنيفها إلى فيديوهات، قنوات، وقوائم تشغيل
 */
async function searchYouTube(query, filterType = 'all') {
    let spParam = '';
    if (filterType === 'channel') spParam = '&sp=EgIQAg%253D%253D';
    else if (filterType === 'playlist') spParam = '&sp=EgIQAw%253D%253D';
    else if (filterType === 'video') spParam = '&sp=EgIQAQ%253D%253D';

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${spParam}`;

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ar,en;q=0.9'
        }
    });

    const html = await response.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/);

    if (!match) {
        return { videos: [], channels: [], playlists: [] };
    }

    const data = JSON.parse(match[1]);
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    const results = { videos: [], channels: [], playlists: [] };

    for (const section of contents) {
        const itemSection = section.itemSectionRenderer?.contents || [];
        for (const item of itemSection) {
            if (item.videoRenderer) {
                const v = item.videoRenderer;
                results.videos.push({
                    type: 'video',
                    id: v.videoId,
                    title: v.title?.runs?.[0]?.text || '',
                    author: v.ownerText?.runs?.[0]?.text || '',
                    thumbnail: v.thumbnail?.thumbnails?.pop()?.url || `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
                    duration: v.lengthText?.simpleText || '',
                    views: v.viewCountText?.simpleText || ''
                });
            } else if (item.channelRenderer) {
                const c = item.channelRenderer;
                results.channels.push({
                    type: 'channel',
                    id: c.channelId,
                    title: c.title?.simpleText || '',
                    thumbnail: c.thumbnail?.thumbnails?.pop()?.url || '',
                    videoCount: c.videoCountText?.runs?.[0]?.text || '',
                    subscriberCount: c.subscriberCountText?.simpleText || ''
                });
            } else if (item.playlistRenderer) {
                const p = item.playlistRenderer;
                results.playlists.push({
                    type: 'playlist',
                    id: p.playlistId,
                    title: p.title?.simpleText || '',
                    author: p.shortBylineText?.runs?.[0]?.text || '',
                    videoCount: p.videoCount || '',
                    thumbnail: p.thumbnails?.[0]?.thumbnails?.pop()?.url || ''
                });
            } else if (item.lockupViewModel) {
                const parsed = parseLockupItem(item.lockupViewModel);
                if (parsed.type === 'playlist') results.playlists.push(parsed);
                else if (parsed.type === 'channel') results.channels.push(parsed);
                else results.videos.push(parsed);
            }
        }
    }

    return results;
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // نقطة نهاية البحث (Search API)
    if (pathname === '/api/search') {
        const q = parsedUrl.searchParams.get('q') || '';
        const type = parsedUrl.searchParams.get('type') || 'all';

        if (!q.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
            return res.end(JSON.stringify({ error: 'Missing query parameter q' }));
        }

        try {
            const data = await searchYouTube(q, type);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=UTF-8',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify(data));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // تقديم الملفات الثابتة
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
                res.end('500 Internal Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 GoTube Server running on http://localhost:${PORT}`);
});
