// js/anthem.js — profile anthem: link parsing + click-to-play card

// Turns a pasted song link into the official embed player URL, or null if unsupported.
// Use it on save (reject null) and on render (build the iframe from the result).
function anthemEmbed(link) {
  let u;
  try { u = new URL(link.trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  // Spotify: open.spotify.com/track/<id>  (also /intl-xx/track/<id>)
  if (host === 'open.spotify.com') {
    const i = parts.indexOf('track');
    const id = i >= 0 ? parts[i + 1] : null;
    return id && /^[A-Za-z0-9]{22}$/.test(id)
      ? { provider: 'spotify', src: `https://open.spotify.com/embed/track/${id}`, height: 80 }
      : null;
  }

  // YouTube: youtube.com/watch?v=<id>, youtu.be/<id>, music.youtube.com/watch?v=<id>, /shorts/<id>
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    const id = host === 'youtu.be' ? parts[0]
      : parts[0] === 'shorts' ? parts[1]
      : u.searchParams.get('v');
    return id && /^[A-Za-z0-9_-]{11}$/.test(id)
      ? { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}`, height: 200 }
      : null;
  }

  // SoundCloud: soundcloud.com/<artist>/<track>
  if (host === 'soundcloud.com') {
    return parts.length === 2 && !['sets', 'tracks'].includes(parts[1])
      ? {
          provider: 'soundcloud',
          src: 'https://w.soundcloud.com/player/?visual=false&show_comments=false&url=' +
               encodeURIComponent(`https://soundcloud.com/${parts[0]}/${parts[1]}`),
          height: 120
        }
      : null;
  }

  // Apple Music: music.apple.com/<country>/album/<name>/<albumId>?i=<songId>  or  /song/<name>/<songId>
  if (host === 'music.apple.com') {
    const isSong = parts[1] === 'song' || (parts[1] === 'album' && u.searchParams.get('i'));
    return isSong
      ? { provider: 'apple', src: `https://embed.music.apple.com${u.pathname}${u.search}`, height: 175 }
      : null;
  }

  return null;
}

// Anthems start at half volume where the player allows it. YouTube and SoundCloud players
// take a "set volume" message from the page; Spotify and Apple Music players don't offer that,
// so they play at the listener's own volume. (iPhones ignore volume changes from a page entirely:
// there it's always the phone's volume buttons.)
const ANTHEM_VOLUME = 50; // percent

function setAnthemVolume(iframe, provider) {
  let send;
  if (provider === 'youtube') {
    const origin = 'https://www.youtube-nocookie.com';
    send = function () {
      const win = iframe.contentWindow;
      if (!win) return;
      // "listening" tells the player this page wants to talk to it; then the command itself
      win.postMessage(JSON.stringify({ event: 'listening', id: 1 }), origin);
      win.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [ANTHEM_VOLUME] }), origin);
    };
  } else if (provider === 'soundcloud') {
    send = function () {
      const win = iframe.contentWindow;
      if (win) win.postMessage(JSON.stringify({ method: 'setVolume', value: ANTHEM_VOLUME }), 'https://w.soundcloud.com');
    };
  } else {
    return; // Spotify, Apple Music: no volume control from the page
  }
  // The player needs a moment after loading before it listens, so send it a few times
  iframe.addEventListener('load', function () {
    [0, 400, 1000, 2000, 3500].forEach(function (ms) { setTimeout(send, ms); });
  }, { once: true });
}

// Renders the placeholder card into `container`; the real player loads only on click.
// link = profile.anthem_url, title = profile.anthem_title ("Song — Artist")
function renderAnthemCard(container, link, title) {
  const embed = anthemEmbed(link || '');
  container.replaceChildren();
  container.hidden = !embed;
  if (!embed) return;

  const label = {
    spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud', apple: 'Apple Music'
  }[embed.provider];

  // "Song — Artist" (also accepts " - " or " – ")
  const parts = (title || '').split(/\s+[—–-]\s+/);
  const song = parts[0] || 'Play anthem';
  const artist = parts.slice(1).join(' — ');

  // Static markup only; user text goes in via textContent below (never innerHTML)
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'profile-anthem-card';
  card.innerHTML =
    '<span class="profile-anthem-play" aria-hidden="true"></span>' +
    '<span class="profile-anthem-text">' +
      '<span class="profile-anthem-label"></span>' +
      '<span class="profile-anthem-song"></span>' +
      '<span class="profile-anthem-artist"></span>' +
    '</span>' +
    '<span class="profile-anthem-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';
  card.querySelector('.profile-anthem-label').textContent = 'Anthem · ' + label;
  card.querySelector('.profile-anthem-song').textContent = song;
  const artistEl = card.querySelector('.profile-anthem-artist');
  if (artist) artistEl.textContent = artist; else artistEl.remove();
  card.setAttribute('aria-label', 'Play anthem: ' + (title || song) + ' on ' + label);

  card.addEventListener('click', function () {
    // YouTube and SoundCloud can start playing right away; Spotify and Apple
    // Music load their player and need one more tap on their own play button.
    let src = embed.src;
    // enablejsapi lets the page set the YouTube player's volume (setAnthemVolume)
    if (embed.provider === 'youtube') src += '?autoplay=1&enablejsapi=1&origin=' + encodeURIComponent(window.location.origin);
    if (embed.provider === 'soundcloud') src += '&auto_play=true';

    const iframe = document.createElement('iframe');
    iframe.className = 'profile-anthem-player';
    iframe.dataset.provider = embed.provider;
    iframe.src = src;
    if (embed.provider !== 'youtube') iframe.style.height = embed.height + 'px';
    iframe.allow = 'autoplay; encrypted-media; clipboard-write; fullscreen; picture-in-picture';
    iframe.title = 'Anthem: ' + (title || song);
    setAnthemVolume(iframe, embed.provider);
    container.replaceChildren(iframe);
  }, { once: true });

  container.appendChild(card);
}
