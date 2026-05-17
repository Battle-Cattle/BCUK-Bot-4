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
