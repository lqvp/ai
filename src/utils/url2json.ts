import got from 'got';
import config from '@/config/index.js';
import log from '@/utils/log.js';

export default async function (url: string): Promise<unknown> {
  try {
    const urlPreviewUrl = config.host + '/url';
    return await got(urlPreviewUrl, {
      searchParams: {
        url: url,
        lang: 'ja-JP',
      },
      timeout: {
        lookup: 500,
        send: 500,
        response: 10000,
      },
    }).json();
  } catch (err: unknown) {
    log('Error in url2json');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    throw err;
  }
}
