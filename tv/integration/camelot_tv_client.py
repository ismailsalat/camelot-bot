"""Backend-only bridge client for a Python Camelot bot (no extra dependencies)."""
import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class CamelotTVClient:
    def __init__(self, base_url, api_key, guild_id):
        url = urllib.parse.urlsplit(base_url)
        if url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
            raise ValueError('Use the TV service origin as base_url')
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1')):
            raise ValueError('Use HTTPS, or localhost for services on the same machine')
        if not isinstance(api_key, str) or len(api_key) < 32 or not re.fullmatch(r'\d{15,22}', str(guild_id)):
            raise ValueError('A valid bridge key and paired server ID are required')
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.guild_id = str(guild_id)

    async def _request(self, path, body=None):
        def call():
            headers = {'Authorization': f'Bearer {self.api_key}'}
            data = None
            if body is not None:
                headers['Content-Type'] = 'application/json'
                data = json.dumps({**body, 'guild': self.guild_id}).encode()
            request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
            try:
                with urllib.request.build_opener(NoRedirect()).open(request, timeout=240) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                try:
                    message = json.load(error).get('error', 'TV service request failed')
                except (ValueError, AttributeError):
                    message = 'TV service request failed'
                raise RuntimeError(message) from None
        return await asyncio.to_thread(call)

    async def state(self):
        return await self._request('/api/state')

    async def search(self, query):
        return await self._request('/api/search?' + urllib.parse.urlencode({'q': query, 'provider': 'all'}))

    async def episodes(self, selection, refresh=False):
        return await self._request('/api/episodes?' + urllib.parse.urlencode({'provider': selection['provider'], 'id': selection['id'], 'refresh': '1' if refresh else '0'}))

    async def play(self, selection, episode, channel=None, audio='sub', subtitles='en', check_only=False):
        return await self._request('/api/check' if check_only else '/api/play', {
            'provider': selection['provider'], 'media': selection['id'], 'unit': episode['id'],
            'channel': channel, 'lang': audio, 'subtitles': subtitles,
        })

    async def stop(self):
        return await self._request('/api/stop', {})
