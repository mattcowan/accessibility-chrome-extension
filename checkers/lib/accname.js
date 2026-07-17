// Simplified accessible-name computation (documented subset of the AccName
// algorithm — good for testing triage, not a spec-complete implementation):
// precedence aria-labelledby > aria-label > native labeling (label[for] /
// wrapping label, alt, value for input buttons, text content) > title.
if (!globalThis.__a11yAccname) {
  globalThis.__a11yAccname = (function () {
    const ROLE_BY_TAG = {
      A: 'link', // only with href; adjusted below
      BUTTON: 'button',
      SELECT: 'combobox',
      TEXTAREA: 'textbox',
      IMG: 'img',
      NAV: 'navigation',
      MAIN: 'main',
      HEADER: 'banner',
      FOOTER: 'contentinfo',
      ASIDE: 'complementary',
      FORM: 'form',
      TABLE: 'table',
      UL: 'list',
      OL: 'list',
      LI: 'listitem',
      H1: 'heading',
      H2: 'heading',
      H3: 'heading',
      H4: 'heading',
      H5: 'heading',
      H6: 'heading',
      SUMMARY: 'button',
      DIALOG: 'dialog',
    };

    const INPUT_ROLES = {
      button: 'button',
      submit: 'button',
      reset: 'button',
      image: 'button',
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      number: 'spinbutton',
      search: 'searchbox',
      email: 'textbox',
      tel: 'textbox',
      text: 'textbox',
      url: 'textbox',
      password: 'textbox',
    };

    function text(s) {
      return (s || '').replace(/\s+/g, ' ').trim();
    }

    function role(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
      if (el.tagName === 'INPUT') return INPUT_ROLES[(el.type || 'text').toLowerCase()] || 'textbox';
      return ROLE_BY_TAG[el.tagName] || 'generic';
    }

    function fromRefs(el, attr) {
      const ids = el.getAttribute(attr);
      if (!ids) return '';
      const root = el.getRootNode();
      return text(
        ids
          .split(/\s+/)
          .map((id) => {
            const ref = root.getElementById ? root.getElementById(id) : null;
            return ref ? ref.textContent : '';
          })
          .join(' ')
      );
    }

    function nativeName(el) {
      const tag = el.tagName;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
        if (el.labels && el.labels.length) {
          return { name: text(el.labels[0].textContent), source: '<label>' };
        }
        if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value) {
          return { name: text(el.value), source: 'value' };
        }
        if (tag === 'INPUT' && el.type === 'image' && el.alt) {
          return { name: text(el.alt), source: 'alt' };
        }
        return null;
      }
      if (tag === 'IMG' || tag === 'AREA') {
        return el.hasAttribute('alt') ? { name: text(el.alt), source: 'alt' } : null;
      }
      // Buttons, links, headings, summaries: name from contents, including
      // alt text of images inside.
      let content = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) content += node.textContent;
        else if (node.nodeType === Node.ELEMENT_NODE) {
          content += node.tagName === 'IMG' ? ` ${node.alt || ''} ` : ` ${node.textContent} `;
        }
      }
      const t = text(content);
      return t ? { name: t, source: 'contents' } : null;
    }

    function compute(el) {
      const labelledby = fromRefs(el, 'aria-labelledby');
      if (labelledby) return { name: labelledby, source: 'aria-labelledby', role: role(el) };

      const ariaLabel = text(el.getAttribute('aria-label'));
      if (ariaLabel) return { name: ariaLabel, source: 'aria-label', role: role(el) };

      const native = nativeName(el);
      if (native && native.name) return { ...native, role: role(el) };

      const title = text(el.getAttribute('title'));
      if (title) return { name: title, source: 'title', role: role(el) };

      return { name: '', source: 'none', role: role(el) };
    }

    function describe(el) {
      const describedby = fromRefs(el, 'aria-describedby');
      if (describedby) return describedby;
      const result = compute(el);
      const title = text(el.getAttribute('title'));
      return title && result.source !== 'title' ? title : '';
    }

    return { compute, describe, role };
  })();
}
