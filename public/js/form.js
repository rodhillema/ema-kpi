/* ============================================================
   Dynamic Form Renderer
   Renders form fields from FormSchema JSON, handles conditional
   logic via showWhen rules, and collects field values.
   ============================================================ */

function renderDynamicForm(container, schema) {
  container.innerHTML = '';
  if (!schema || !schema.fields) return;

  schema.fields.forEach(field => {
    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = `field-group-${field.id}`;
    group.dataset.fieldId = field.id;

    // Hidden by default if has showWhen
    if (field.showWhen) {
      group.classList.add('hidden');
    }

    // Label
    const label = document.createElement('label');
    label.setAttribute('for', `field-${field.id}`);
    label.textContent = field.label;
    if (field.required) {
      const req = document.createElement('span');
      req.textContent = ' *';
      req.style.color = 'var(--accent)';
      label.appendChild(req);
    }
    group.appendChild(label);

    // Render field by type
    switch (field.type) {
      case 'text':
        group.appendChild(createInput(field, 'text'));
        break;

      case 'textarea':
        group.appendChild(createTextarea(field));
        break;

      case 'select':
        group.appendChild(createSelect(field));
        break;

      case 'multiselect':
        group.appendChild(createMultiSelect(field));
        break;

      case 'radio':
        group.appendChild(createRadioGroup(field));
        break;

      case 'file':
        group.appendChild(createFileUpload(field));
        break;

      case 'advocate_lookup':
        group.appendChild(createAdvocateLookup(field));
        break;

      default:
        group.appendChild(createInput(field, 'text'));
    }

    container.appendChild(group);
  });

  // Set up conditional logic watchers
  schema.fields.forEach(field => {
    if (field.showWhen) {
      setupConditional(field, container);
    }
  });
}

function createInput(field, type) {
  const input = document.createElement('input');
  input.type = type;
  input.id = `field-${field.id}`;
  input.name = field.id;
  input.placeholder = field.placeholder || '';
  if (field.required) input.required = true;
  return input;
}

function createTextarea(field) {
  const textarea = document.createElement('textarea');
  textarea.id = `field-${field.id}`;
  textarea.name = field.id;
  textarea.placeholder = field.placeholder || '';
  textarea.rows = 4;
  if (field.required) textarea.required = true;
  return textarea;
}

function createSelect(field) {
  const select = document.createElement('select');
  select.id = `field-${field.id}`;
  select.name = field.id;
  if (field.required) select.required = true;

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select...';
  select.appendChild(defaultOpt);

  (field.options || []).forEach(opt => {
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = opt;
    select.appendChild(option);
  });

  return select;
}

function createMultiSelect(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'checkbox-group';

  (field.options || []).forEach(opt => {
    const label = document.createElement('label');
    label.className = 'checkbox-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = field.id;
    checkbox.value = opt;

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(opt));
    wrapper.appendChild(label);
  });

  return wrapper;
}

function createRadioGroup(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'radio-group';

  (field.options || []).forEach(opt => {
    const label = document.createElement('label');
    label.className = 'radio-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = field.id;
    radio.value = opt;
    if (field.required) radio.required = true;

    label.appendChild(radio);
    label.appendChild(document.createTextNode(opt));
    wrapper.appendChild(label);
  });

  return wrapper;
}

function createFileUpload(field) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="file-upload">
      <input type="file" id="field-${field.id}" name="${field.id}" accept="image/*,.pdf">
      <p>Click or drag a file here</p>
    </div>
    <div class="file-preview"></div>
  `;
  // Init upload handler after DOM is attached
  setTimeout(() => initFileUpload(wrapper, field.id), 0);
  return wrapper;
}

function createAdvocateLookup(field) {
  const wrapper = document.createElement('div');

  const row = document.createElement('div');
  row.className = 'flex gap-sm';
  row.style.alignItems = 'flex-end';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = `field-${field.id}`;
  input.name = field.id;
  input.placeholder = 'Enter advocate ID...';
  input.style.flex = '1';

  const lookupBtn = document.createElement('button');
  lookupBtn.type = 'button';
  lookupBtn.className = 'btn btn-secondary btn-sm';
  lookupBtn.textContent = 'Verify';
  lookupBtn.style.whiteSpace = 'nowrap';

  row.appendChild(input);
  row.appendChild(lookupBtn);
  wrapper.appendChild(row);

  const resultEl = document.createElement('div');
  resultEl.id = `advocate-result-${field.id}`;
  wrapper.appendChild(resultEl);

  lookupBtn.addEventListener('click', async () => {
    const advocateId = input.value.trim();
    if (!advocateId) return;

    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Checking...';
    resultEl.innerHTML = '';

    try {
      const res = await fetch(`/api/advocate-lookup/${encodeURIComponent(advocateId)}`);
      if (!res.ok) {
        const err = await res.json();
        resultEl.innerHTML = `<div class="advocate-result error">${err.error || 'Not found'}</div>`;
        return;
      }
      const data = await res.json();
      resultEl.innerHTML = `<div class="advocate-result">${data.firstName} ${data.lastName}</div>`;
      // Store advocate name for ticket submission
      window._advocateName = `${data.firstName} ${data.lastName}`;
    } catch (err) {
      resultEl.innerHTML = `<div class="advocate-result error">Lookup failed</div>`;
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Verify';
    }
  });

  return wrapper;
}

function setupConditional(field, container) {
  const { fieldId, value } = field.showWhen;
  const targetGroup = container.querySelector(`#field-group-${field.id}`);
  if (!targetGroup) return;

  // Watch the controlling field for changes
  const controlEl = container.querySelector(`#field-${fieldId}`);
  if (!controlEl) return;

  const check = () => {
    let currentVal;
    if (controlEl.tagName === 'SELECT' || controlEl.tagName === 'INPUT') {
      currentVal = controlEl.value;
    }
    if (currentVal === value) {
      targetGroup.classList.remove('hidden');
    } else {
      targetGroup.classList.add('hidden');
    }
  };

  controlEl.addEventListener('change', check);
  controlEl.addEventListener('input', check);

  // Also check radio groups
  const radios = container.querySelectorAll(`input[name="${fieldId}"]`);
  radios.forEach(radio => {
    radio.addEventListener('change', () => {
      const checked = container.querySelector(`input[name="${fieldId}"]:checked`);
      if (checked && checked.value === value) {
        targetGroup.classList.remove('hidden');
      } else {
        targetGroup.classList.add('hidden');
      }
    });
  });
}

function collectFieldValues(container, schema) {
  const values = {};
  if (!schema || !schema.fields) return values;

  schema.fields.forEach(field => {
    const group = container.querySelector(`#field-group-${field.id}`);
    if (!group || group.classList.contains('hidden')) return;

    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'select':
      case 'advocate_lookup': {
        const el = container.querySelector(`#field-${field.id}`);
        if (el && el.value.trim()) values[field.id] = el.value.trim();
        break;
      }

      case 'multiselect': {
        const checked = container.querySelectorAll(`input[name="${field.id}"]:checked`);
        const vals = Array.from(checked).map(cb => cb.value);
        if (vals.length > 0) values[field.id] = vals;
        break;
      }

      case 'radio': {
        const checked = container.querySelector(`input[name="${field.id}"]:checked`);
        if (checked) values[field.id] = checked.value;
        break;
      }

      case 'file':
        // Files handled separately via upload
        break;
    }
  });

  return values;
}

function validateDynamicFields(container, schema) {
  if (!schema || !schema.fields) return [];
  const errors = [];

  schema.fields.forEach(field => {
    if (!field.required) return;
    const group = container.querySelector(`#field-group-${field.id}`);
    if (!group || group.classList.contains('hidden')) return;

    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'select':
      case 'advocate_lookup': {
        const el = container.querySelector(`#field-${field.id}`);
        if (!el || !el.value.trim()) {
          errors.push(field.label);
        }
        break;
      }
      case 'radio': {
        const checked = container.querySelector(`input[name="${field.id}"]:checked`);
        if (!checked) errors.push(field.label);
        break;
      }
    }
  });

  return errors;
}
