/* ============================================================
   Cloudinary Upload Client
   Handles file selection, preview, and server-side upload
   ============================================================ */

function initFileUpload(fieldEl, fieldId) {
  const dropzone = fieldEl.querySelector('.file-upload');
  const input = fieldEl.querySelector('input[type="file"]');
  const preview = fieldEl.querySelector('.file-preview');

  dropzone.addEventListener('click', () => input.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--accent)';
    dropzone.style.background = 'var(--accent-light)';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = '';
    dropzone.style.background = '';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '';
    dropzone.style.background = '';
    if (e.dataTransfer.files.length > 0) {
      input.files = e.dataTransfer.files;
      handleFileSelected(input.files[0], dropzone, preview, fieldId);
    }
  });

  input.addEventListener('change', () => {
    if (input.files.length > 0) {
      handleFileSelected(input.files[0], dropzone, preview, fieldId);
    }
  });
}

function handleFileSelected(file, dropzone, previewEl, fieldId) {
  dropzone.classList.add('has-file');
  previewEl.innerHTML = '';

  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    previewEl.appendChild(img);
  }

  const name = document.createElement('span');
  name.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  previewEl.appendChild(name);

  // Store file reference for upload during submission
  if (!window._pendingUploads) window._pendingUploads = {};
  window._pendingUploads[fieldId] = file;
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Upload failed');
  }

  return response.json();
}

async function uploadAllPendingFiles() {
  const results = [];
  if (!window._pendingUploads) return results;

  for (const [fieldId, file] of Object.entries(window._pendingUploads)) {
    const result = await uploadFile(file);
    results.push(result);
  }

  window._pendingUploads = {};
  return results;
}
