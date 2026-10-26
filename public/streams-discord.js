/* global formatValue, sanitizeUrl, createLink */

/**
 * The preview's plain message text, or a muted placeholder when the message has none.
 * @param content - The message text, or an empty string when there is none.
 * @returns The `.discord-message-content` element.
 */
function createMessageContent(content) {
  var div = document.createElement('div');
  div.className = 'discord-message-content';
  if (content) {
    div.textContent = content;
  } else {
    var muted = document.createElement('span');
    muted.className = 'muted';
    muted.textContent = 'No message content';
    div.appendChild(muted);
  }
  return div;
}

/**
 * The embed's title, linked to its URL when that URL passed sanitizeUrl.
 * @param embed - The preview's embed; its `title` is shown.
 * @param safeEmbedUrl - The embed URL after sanitizeUrl, or null to render the title unlinked.
 * @returns The `.discord-embed-title` element.
 */
function createEmbedTitle(embed, safeEmbedUrl) {
  var div = document.createElement('div');
  div.className = 'discord-embed-title';
  if (safeEmbedUrl) {
    var a = document.createElement('a');
    a.href = safeEmbedUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = formatValue(embed.title);
    div.appendChild(a);
  } else {
    div.textContent = formatValue(embed.title);
  }
  return div;
}

/**
 * The embed's name/value fields, or a muted placeholder when it has none.
 * @param fields - The embed's `{ name, value }` fields; anything not an array counts as none.
 * @returns The `.discord-embed-fields` element.
 */
function createEmbedFields(fields) {
  var div = document.createElement('div');
  div.className = 'discord-embed-fields';
  var list = Array.isArray(fields) ? fields.filter(Boolean) : [];
  if (list.length) {
    list.forEach(function(field) {
      var fieldDiv = document.createElement('div');
      fieldDiv.className = 'discord-embed-field';
      var nameDiv = document.createElement('div');
      nameDiv.className = 'discord-embed-field-name';
      nameDiv.textContent = formatValue(field.name);
      var valueDiv = document.createElement('div');
      valueDiv.className = 'discord-embed-field-value';
      valueDiv.textContent = formatValue(field.value);
      fieldDiv.appendChild(nameDiv);
      fieldDiv.appendChild(valueDiv);
      div.appendChild(fieldDiv);
    });
  } else {
    var noFields = document.createElement('div');
    noFields.className = 'discord-embed-field';
    var muted = document.createElement('span');
    muted.className = 'muted';
    muted.textContent = 'No embed fields';
    noFields.appendChild(muted);
    div.appendChild(noFields);
  }
  return div;
}

/**
 * The embed's thumbnail when it has a safe https URL, otherwise a muted placeholder.
 * @param safeImageUrl - The https thumbnail URL after sanitizeUrl, or null when unavailable.
 * @returns The `.discord-embed-image` element.
 */
function createEmbedImage(safeImageUrl) {
  var div = document.createElement('div');
  div.className = 'discord-embed-image';
  if (safeImageUrl) {
    var img = document.createElement('img');
    img.src = safeImageUrl;
    img.alt = 'Stream thumbnail preview';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    div.appendChild(img);
  } else {
    var muted = document.createElement('span');
    muted.className = 'muted';
    muted.textContent = 'Thumbnail unavailable';
    div.appendChild(muted);
  }
  return div;
}

/**
 * A Discord-style embed preview: accent bar, title, fields and image.
 * @param embed - The preview's embed (`title`, `fields`).
 * @param safeEmbedUrl - The sanitized embed URL, or null to leave the title unlinked.
 * @param safeImageUrl - The sanitized https thumbnail URL, or null for a placeholder and no footer link.
 * @returns The `.discord-embed-preview` element.
 */
function createDiscordEmbed(embed, safeEmbedUrl, safeImageUrl) {
  var preview = document.createElement('div');
  preview.className = 'discord-embed-preview';

  var accent = document.createElement('div');
  accent.className = 'discord-embed-accent';
  preview.appendChild(accent);

  var body = document.createElement('div');
  body.className = 'discord-embed-body';
  body.appendChild(createEmbedTitle(embed, safeEmbedUrl));
  body.appendChild(createEmbedFields(embed.fields));
  body.appendChild(createEmbedImage(safeImageUrl));

  if (safeImageUrl) {
    var footer = document.createElement('div');
    footer.className = 'discord-embed-footer';
    footer.textContent = 'Image: ';
    footer.appendChild(createLink(safeImageUrl, 'open thumbnail'));
    body.appendChild(footer);
  }

  preview.appendChild(body);
  return preview;
}

/**
 * A titled preview of a Discord live-announcement message: its text and, when it has one, its embed.
 * @param title - Heading for the preview, e.g. "Live Announcement Preview".
 * @param preview - The message preview from GET /admin/streams/live (`content`, optional `embed`), or null/undefined.
 * @returns The `.live-message-preview` section.
 */
function createMessagePreview(title, preview) {
  var embed = preview && preview.embed ? preview.embed : null;
  var content = preview ? formatValue(preview.content, '') : '';
  var safeEmbedUrl = embed ? sanitizeUrl(embed.url) : null;
  var safeImageUrl = embed ? sanitizeUrl(embed.imageUrl, { requireHttps: true }) : null;

  var section = document.createElement('section');
  section.className = 'live-message-preview';

  var h4 = document.createElement('h4');
  h4.className = 'live-message-title';
  h4.textContent = title;
  section.appendChild(h4);

  var msgBox = document.createElement('div');
  msgBox.className = 'discord-message-box';
  msgBox.appendChild(createMessageContent(content));
  if (embed) {
    msgBox.appendChild(createDiscordEmbed(embed, safeEmbedUrl, safeImageUrl));
  }

  section.appendChild(msgBox);
  return section;
}
