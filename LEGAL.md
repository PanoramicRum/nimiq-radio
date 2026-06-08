# Legal, Copyright & Acceptable Use

> **Status: prototype.** Nimiq Radio is a hackathon/competition prototype, not a public
> production service. Operating it publicly carries real legal risk (see below). Read this
> before deploying it anywhere others can reach.

## Copyright & source content

Nimiq Radio accepts links to third-party media (currently YouTube), downloads and
transcodes the audio server-side, and serves it for shared playback.

- **Downloading from YouTube generally violates the YouTube Terms of Service**, and the
  submitted content is frequently protected by copyright.
- No configuration or code change removes this risk. Paying NIM to submit a song does **not**
  grant any license to the underlying content.

If you operate this software for anyone other than yourself, **you** are responsible for:

- obtaining the rights/licenses for any content you make available, **or** restricting
  submissions to licensed / Creative-Commons / royalty-free sources;
- complying with the terms of service of every source platform you enable;
- responding to takedown requests promptly.

A safer path for a real launch is to swap the media-source layer (the `SourceValidator` /
`Downloader` seam) to a licensed catalog.

## Temporary files & retention

Downloaded audio is stored temporarily and deleted automatically: files age out after a TTL
(`FILE_TTL_MIN`), and the store is bounded by a disk cap (`DISK_CAP_MB`, LRU eviction). Files
are served from opaque, high-entropy URLs. No long-term archive of submitted audio is kept.

## Payments & use of funds

Payments are made in NIM directly to the configured receiving address and verified on-chain.
The service does not custody funds beyond the received payment. **Payments are
non-refundable** by default; if a paid song cannot be made playable, contact the operator.

**Where the money goes:** all NIM contributed through the radio is treated as a donation. The
collected funds are **staked**, and the proceeds are **eventually donated to a music
foundation selected by the Nimiq Community**. Contributing to play or boost a song is a
donation toward that cause, not a purchase of any content or license.

## Notice and takedown

To report allegedly infringing content, contact the operator of this instance with the track
URL and a description of the issue; reported content will be removed promptly.

**Operator contact:** _TODO: set before any non-private deployment._

## Privacy

The backend logs request metadata (IP, timestamps) and stores, per queued song, the on-chain
sender address and amount (public blockchain data). No other personal data is collected.

## No warranty

This software is provided "as is", without warranty of any kind. The authors are not liable
for how it is deployed or used.
