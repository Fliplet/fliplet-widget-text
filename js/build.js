(function() {
  const editors = {};

  // Native debounce function to replace _.debounce
  function debounce(func, wait, options = {}) {
    let timeout;

    return function executedFunction(...args) {
      const later = () => {
        timeout = null;
        if (!options.leading) func.apply(this, args);
      };
      const callNow = options.leading && !timeout;

      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func.apply(this, args);
    };
  }

  Fliplet.Widget.instance('text', function(widgetData) {
    const el = this;
    let editor;
    const MIRROR_ELEMENT_CLASS = 'fl-mirror-element';
    const MIRROR_ROOT_CLASS = 'fl-mirror-root';
    const WIDGET_INSTANCE_SELECTOR = '[data-fl-widget-instance]';
    const isDev = Fliplet.Env.get('development');
    let isInitialized = false;
    let onBlur = false;
    let lastScriptIntent = null;
    let isFixingScriptState = false;
    let isApplyingStickyColors = false;
    let lastSavedHtml;
    let blurDisableTimer = null;
    let lastCaretMoveIntent = null; // 'enter' | 'click' | null
    let highlightRafId = null;
    let nodeChangedRafId = null;
    const defaultColors = {
      foreColor: null,
      backColor: null
    };
    const defaultFonts = {
      fontFamily: null,
      fontSize: null
    };
    const stickyColors = {
      foreColor: null,
      backColor: null
    };
    const stickyFonts = {
      fontFamily: null,
      fontSize: null
    };

    const isDebugEnabled = () => {
      try {
        return Fliplet.Env.get('development') && window.localStorage && window.localStorage.getItem('flTextDebug') === '1';
      } catch (e) {
        return false;
      }
    };

    const debugLog = (...args) => {
      if (!isDebugEnabled()) return;

      try {
        // eslint-disable-next-line no-console
        console.log('[text-widget]', ...args);
      } catch (e) {
        /* no-op */
      }
    };

    const scheduleHighlightUpdate = (id) => {
      if (highlightRafId) return;

      const run = () => {
        highlightRafId = null;

        try {
          if (typeof id === 'undefined') {
            Fliplet.Widget.updateHighlightDimensions();
          } else {
            Fliplet.Widget.updateHighlightDimensions(id);
          }
        } catch (e) {
          /* no-op */
        }
      };

      try {
        highlightRafId = requestAnimationFrame(run);
      } catch (e) {
        highlightRafId = setTimeout(run, 0);
      }
    };

    const scheduleNodeChanged = (ed) => {
      if (!ed || nodeChangedRafId) return;

      const run = () => {
        nodeChangedRafId = null;

        try {
          ed.nodeChanged();
        } catch (e) {
          /* no-op */
        }
      };

      try {
        nodeChangedRafId = requestAnimationFrame(run);
      } catch (e) {
        nodeChangedRafId = setTimeout(run, 0);
      }
    };

    const cancelPendingBlurDisable = () => {
      if (blurDisableTimer) {
        clearTimeout(blurDisableTimer);
        blurDisableTimer = null;
      }
    };

    const getMode = () => {
      const mode = Fliplet.Env.get('mode');

      return mode === 'interact' && el.closest('fl-list-repeater-row.readonly')
        ? 'preview'
        : mode;
    };

    const cleanUpContent = (content) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content || '', 'text/html');

      // Remove any existing markers
      doc.querySelectorAll('.' + MIRROR_ELEMENT_CLASS).forEach(el => el.classList.remove(MIRROR_ELEMENT_CLASS));
      doc.querySelectorAll('.' + MIRROR_ROOT_CLASS).forEach(el => el.classList.remove(MIRROR_ROOT_CLASS));
      doc.querySelectorAll('.fl-wysiwyg-text .fl-wysiwyg-text.mce-content-body').forEach(el => {
        el.replaceWith(...el.childNodes);
      });

      // Remove empty class attributes
      doc.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));

      // Remove caret-holder helper elements and zero-width characters.
      // Important: when users apply styles (e.g. background color) before typing,
      // TinyMCE can apply styles onto our caret-holder element. If we always unwrap it,
      // we would unintentionally strip those styles and the user would think the setting
      // didn't apply. Therefore:
      // - unwrap caret-holders ONLY if they have no meaningful attributes (i.e. were purely helpers)
      // - keep (but de-mark) caret-holders if they gained styles/classes
      doc.querySelectorAll('[data-fl-caret-holder]').forEach((caretEl) => {
        const hasMeaningfulAttributes = Array.from(caretEl.attributes || []).some((attr) => {
          return attr && attr.name !== 'data-fl-caret-holder';
        });

        if (hasMeaningfulAttributes) {
          caretEl.removeAttribute('data-fl-caret-holder');

          return;
        }

        caretEl.replaceWith(...caretEl.childNodes);
      });

      // Remove zero-width characters, but preserve them when they are the ONLY content
      // of an element that has inline styles (this keeps "pending" formats persistent).
      try {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();

        while (textNode) {
          const value = textNode.nodeValue || '';

          if (!value || (!value.includes('\u200B') && !value.includes('\uFEFF'))) {
            textNode = walker.nextNode();
            continue;
          }

          const stripped = value.replace(/\u200B|\uFEFF/g, '');
          const parentEl = textNode.parentElement;
          const isOnlyZw = stripped.length === 0;
          const parentHasInlineStyle = parentEl && parentEl.hasAttribute && parentEl.hasAttribute('style');

          if (isOnlyZw && parentHasInlineStyle) {
            textNode = walker.nextNode();
            continue;
          }

          textNode.nodeValue = stripped;
          textNode = walker.nextNode();
        }
      } catch (e) {
        // Fallback to previous behaviour if TreeWalker isn't available
        doc.body.innerHTML = doc.body.innerHTML.replace(/\u200B|\uFEFF/g, '');
      }

      return doc.body.innerHTML.trim();
    };

    const replaceWidgetInstances = (html) => {
      const tempDiv = document.createElement('div');

      tempDiv.innerHTML = html;

      tempDiv.querySelectorAll(WIDGET_INSTANCE_SELECTOR).forEach(el => {
        const widgetInstanceId = el.dataset.id;

        el.outerHTML = `{{{widget ${widgetInstanceId}}}}`;
      });

      return tempDiv.innerHTML;
    };

    const normalizeColor = (value) => {
      if (!value) return null;
      const v = String(value).trim();

      if (!v || v === 'transparent' || v === 'inherit') return null;

      // Treat fully transparent rgba as "no color"
      const rgbaTransparent = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)$/i;

      if (rgbaTransparent.test(v)) return null;

      return v;
    };

    const normalizeFontFamily = (value) => {
      if (!value) return null;
      const v = String(value).trim();

      return v ? v : null;
    };

    const normalizeFontSize = (value) => {
      if (!value) return null;
      const v = String(value).trim();

      return v ? v : null;
    };

    const setCaretMoveIntent = (intent) => {
      lastCaretMoveIntent = intent;
      // Reset after the interaction settles
      setTimeout(() => {
        if (lastCaretMoveIntent === intent) {
          lastCaretMoveIntent = null;
        }
      }, 250);
    };

    const isEmptyBlockAtCaret = (ed) => {
      try {
        const node = ed.selection && typeof ed.selection.getNode === 'function'
          ? ed.selection.getNode()
          : null;
        const block = node ? ed.dom.getParent(node, 'p,h1,h2,h3,h4,h5,h6,pre,blockquote,li,td,th,div') : null;

        if (!block) return false;

        // Consider blocks with just <br>, caret-holder, or whitespace as "empty"
        const text = (block.textContent || '').replace(/\u200B|\uFEFF/g, '').trim();

        if (text.length > 0) return false;

        const html = (block.innerHTML || '').trim().toLowerCase();

        return html === '<br>' || html === '' || html.includes('data-fl-caret-holder');
      } catch (e) {
        return false;
      }
    };

    const readActiveColors = (ed) => {
      // Important: In tables, computed backgroundColor often comes from the <td> (e.g. white),
      // which is NOT the same as TinyMCE "text highlight" (hilitecolor). For persistence and
      // toolbar state, we want the *inline formatting* near the caret.
      //
      // However, TinyMCE (or pasted HTML) can express formatting using:
      // - `style="background: ..."` shorthand (not `background-color`)
      // - legacy attributes like <font color="..."> / bgcolor="..."
      // - CSS classes (computed styles, no inline style)
      //
      // To avoid stale toolbar colors in Studio, we:
      // - prefer inline styles/attributes
      // - fall back to computed styles ONLY on inline-ish elements (never table cells/blocks)
      let foreColor = null;
      let backColor = null;

      const isBlockLike = (el) => {
        const name = (el && el.nodeName ? el.nodeName : '').toLowerCase();

        return [
          'p', 'div',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'pre', 'blockquote',
          'li', 'ol', 'ul',
          'table', 'tbody', 'thead', 'tfoot', 'tr',
          'td', 'th'
        ].includes(name);
      };

      const getAttr = (el, attrName) => {
        try {
          return el && typeof el.getAttribute === 'function' ? el.getAttribute(attrName) : null;
        } catch (e) {
          return null;
        }
      };

      try {
        let node = null;

        try {
          node = ed.selection && typeof ed.selection.getStart === 'function'
            ? ed.selection.getStart(true)
            : null;
        } catch (e) {
          node = null;
        }

        if (node && node.nodeType === 3) {
          node = node.parentElement;
        }

        let cur = (node && node.nodeType === 1) ? node : null;
        const body = ed.getBody ? ed.getBody() : null;

        while (cur && cur !== body) {
          if (!foreColor) {
            const inlineColor = normalizeColor(cur.style && cur.style.color);
            const attrColor = normalizeColor(getAttr(cur, 'color')); // e.g. <font color="...">
            const candidate = inlineColor || attrColor;

            if (candidate) {
              foreColor = candidate;
            } else if (!isBlockLike(cur)) {
              // Computed fallback for class-based styling or legacy markup without inline styles
              try {
                const cs = window.getComputedStyle(cur);
                const computedColor = normalizeColor(cs && cs.color);
                const isDefault = defaultColors.foreColor && computedColor && computedColor === defaultColors.foreColor;

                if (computedColor && !isDefault) {
                  foreColor = computedColor;
                }
              } catch (e) {
                /* no-op */
              }
            }
          }

          if (!backColor) {
            // Try inline highlight first
            const inlineBgColor = normalizeColor(cur.style && cur.style.backgroundColor);
            // Some content uses `background` shorthand (e.g. `background: #ff0;`)
            const inlineBg = normalizeColor(cur.style && cur.style.background);
            const attrBg = normalizeColor(getAttr(cur, 'bgcolor')); // legacy HTML
            const candidate = inlineBgColor || inlineBg || attrBg;

            if (candidate) {
              backColor = candidate;
            } else if (!isBlockLike(cur)) {
              // Computed fallback for class-based highlight
              try {
                const cs = window.getComputedStyle(cur);
                const computedBg = normalizeColor(cs && cs.backgroundColor);
                const isDefault = defaultColors.backColor && computedBg && computedBg === defaultColors.backColor;

                if (computedBg && !isDefault) {
                  backColor = computedBg;
                }
              } catch (e) {
                /* no-op */
              }
            }
          }

          if (foreColor && backColor) break;
          cur = cur.parentElement;
        }
      } catch (e) {
        foreColor = null;
        backColor = null;
      }

      return { foreColor, backColor };
    };

    const readCommandColors = (ed) => {
      // Ask TinyMCE for the active "typing" formats, used when caret is on an empty line.
      let foreColor = null;
      let backColor = null;

      if (!ed || typeof ed.queryCommandValue !== 'function') {
        return { foreColor, backColor };
      }

      const isFormatActive = (formatName) => {
        try {
          return !!(ed.formatter && typeof ed.formatter.match === 'function' && ed.formatter.match(formatName));
        } catch (e) {
          return false;
        }
      };

      try {
        // queryCommandValue can return the last used value even when not active,
        // so only trust it when the corresponding format is active.
        if (isFormatActive('forecolor')) {
          foreColor = normalizeColor(ed.queryCommandValue('ForeColor'));
        }
      } catch (e) {
        /* no-op */
      }

      try {
        if (isFormatActive('hilitecolor')) {
          backColor = normalizeColor(ed.queryCommandValue('HiliteColor'));
        }
      } catch (e) {
        /* no-op */
      }

      if (!backColor) {
        try {
          // Some TinyMCE configs use BackColor, still guarded by hilitecolor being active.
          if (isFormatActive('hilitecolor')) {
            backColor = normalizeColor(ed.queryCommandValue('BackColor'));
          }
        } catch (e) {
          /* no-op */
        }
      }

      return { foreColor, backColor };
    };

    const readActiveFonts = (ed) => {
      // Similar to colors: when caret is within content, computed styles are the most reliable
      // representation of the "current" font shown in Studio's toolbar.
      //
      // We only use this for persisting "sticky" typing styles into new empty blocks (e.g. after tables).
      let fontFamily = null;
      let fontSize = null;

      try {
        let node = null;

        try {
          node = ed.selection && typeof ed.selection.getStart === 'function'
            ? ed.selection.getStart(true)
            : null;
        } catch (e) {
          node = null;
        }

        if (node && node.nodeType === 3) {
          node = node.parentElement;
        }

        if (node && node.nodeType === 1) {
          const cs = window.getComputedStyle(node);

          fontFamily = normalizeFontFamily(cs && cs.fontFamily);
          fontSize = normalizeFontSize(cs && cs.fontSize);
        }
      } catch (e) {
        fontFamily = null;
        fontSize = null;
      }

      return { fontFamily, fontSize };
    };

    const syncStickyColorsFromCaret = (ed) => {
      if (!ed || isApplyingStickyColors) return;

      const { foreColor, backColor } = readActiveColors(ed);

      // Don't overwrite sticky colors with "null" just because the caret is in a brand-new empty block
      // However, if the user CLICKED into an empty/default block, we should revert to default.
      // Note: This behaviour caused a regression after tables: clicking into the empty paragraph after a
      // table would wipe sticky colors, so typing reverted to defaults while Studio toolbar still showed
      // the previous colors. To keep toolbar and typing consistent, we never overwrite sticky colors
      // with null values when caret is in an empty block (regardless of intent).
      if (isEmptyBlockAtCaret(ed)) {
        if (foreColor) stickyColors.foreColor = foreColor;
        if (backColor) stickyColors.backColor = backColor;

        return;
      }

      stickyColors.foreColor = foreColor;
      stickyColors.backColor = backColor;
    };

    const syncStickyFontsFromCaret = (ed) => {
      if (!ed || isApplyingStickyColors) return;

      const { fontFamily, fontSize } = readActiveFonts(ed);

      // Same rule as colors: never wipe sticky fonts just because caret is on an empty/new block.
      if (isEmptyBlockAtCaret(ed)) {
        if (fontFamily) stickyFonts.fontFamily = fontFamily;
        if (fontSize) stickyFonts.fontSize = fontSize;

        return;
      }

      stickyFonts.fontFamily = fontFamily;
      stickyFonts.fontSize = fontSize;
    };

    const applyStickyColorsIfNeeded = (ed) => {
      if (!ed || isApplyingStickyColors) return;
      if (!stickyColors.foreColor && !stickyColors.backColor) return;

      // Only re-apply when the selection is collapsed and the caret is in an empty/new block
      try {
        if (!(ed.selection && typeof ed.selection.isCollapsed === 'function' && ed.selection.isCollapsed())) {
          return;
        }
      } catch (e) {
        return;
      }

      if (!isEmptyBlockAtCaret(ed)) return;

      isApplyingStickyColors = true;

      try {
        ed.undoManager.transact(() => {
          // Apply forecolor/backcolor so subsequent typing continues with these formats
          if (stickyColors.foreColor) {
            try {
              if (ed.formatter && typeof ed.formatter.apply === 'function') {
                ed.formatter.apply('forecolor', { value: stickyColors.foreColor });
              } else {
                ed.execCommand('ForeColor', false, stickyColors.foreColor);
              }
            } catch (e) {
              /* no-op */
            }
          }

          if (stickyColors.backColor) {
            try {
              if (ed.formatter && typeof ed.formatter.apply === 'function') {
                ed.formatter.apply('hilitecolor', { value: stickyColors.backColor });
              } else {
                ed.execCommand('HiliteColor', false, stickyColors.backColor);
              }
            } catch (e) {
              try {
                if (ed.formatter && typeof ed.formatter.apply === 'function') {
                  ed.formatter.apply('hilitecolor', { value: stickyColors.backColor });
                } else {
                  ed.execCommand('BackColor', false, stickyColors.backColor);
                }
              } catch (err) {
                /* no-op */
              }
            }
          }
        });
      } catch (e) {
        /* no-op */
      } finally {
        isApplyingStickyColors = false;
      }
    };

    const applyStickyFontsIfNeeded = (ed) => {
      if (!ed || isApplyingStickyColors) return;
      if (!stickyFonts.fontFamily && !stickyFonts.fontSize) return;

      try {
        if (!(ed.selection && typeof ed.selection.isCollapsed === 'function' && ed.selection.isCollapsed())) {
          return;
        }
      } catch (e) {
        return;
      }

      if (!isEmptyBlockAtCaret(ed)) return;

      isApplyingStickyColors = true;

      try {
        ed.undoManager.transact(() => {
          if (stickyFonts.fontFamily && (!defaultFonts.fontFamily || stickyFonts.fontFamily !== defaultFonts.fontFamily)) {
            try {
              ed.execCommand('FontName', false, stickyFonts.fontFamily);
            } catch (e) {
              try {
                if (ed.formatter && typeof ed.formatter.apply === 'function') {
                  ed.formatter.apply('fontname', { value: stickyFonts.fontFamily });
                }
              } catch (err) {
                /* no-op */
              }
            }
          }

          if (stickyFonts.fontSize && (!defaultFonts.fontSize || stickyFonts.fontSize !== defaultFonts.fontSize)) {
            try {
              ed.execCommand('FontSize', false, stickyFonts.fontSize);
            } catch (e) {
              try {
                if (ed.formatter && typeof ed.formatter.apply === 'function') {
                  ed.formatter.apply('fontsize', { value: stickyFonts.fontSize });
                }
              } catch (err) {
                /* no-op */
              }
            }
          }
        });
      } catch (e) {
        /* no-op */
      } finally {
        isApplyingStickyColors = false;
      }
    };

    const saveChanges = async() => {
      if (getMode() === 'preview') {
        return;
      }

      const editorContent = editor && typeof editor.getContent === 'function' ? editor.getContent() : undefined;

      const data = {
        // Preserve empty string; only fall back when truly null/undefined
        html: (editorContent !== undefined && editorContent !== null) ? editorContent : widgetData.html
      };

      // Use a more careful cleaning approach
      const cleanedUpContent = cleanUpContent(data.html);

      // Allow empty content to be saved
      data.html = cleanedUpContent;

      onBlur = false;

      // Use a DOMParser to handle HTML parsing, which should preserve table structures
      const parser = new DOMParser();
      const doc = parser.parseFromString(data.html, 'text/html');

      // Replace widget instances
      doc.querySelectorAll(WIDGET_INSTANCE_SELECTOR).forEach(el => {
        const widgetInstanceId = el.dataset.id;

        el.outerHTML = `{{{widget ${widgetInstanceId}}}}`;
      });

      const replacedHTML = replaceWidgetInstances(doc.body.innerHTML);

      // Pass HTML content through a hook so any JavaScript that has changed the HTML
      // can use this to revert the HTML changes
      const html = await Fliplet.Hooks.run('beforeSavePageContent', replacedHTML);

      const htmlArray = Array.isArray(html) ? html : [html];

      data.html = htmlArray[htmlArray.length - 1] || replacedHTML;

      // Cache HTML for the first time
      // The first save is always triggered by 'nodeChange' event on focus
      // so there's no need to save anything
      if (typeof lastSavedHtml === 'undefined') {
        lastSavedHtml = data.html;
      }

      // HTML has not changed. No need to save.
      if (lastSavedHtml === data.html) {
        return;
      }

      lastSavedHtml = data.html;

      if (!Fliplet.Env.get('development')) {
        await Fliplet.API.request({
          url: `v1/widget-instances/${widgetData.id}`,
          method: 'PUT',
          data
        });
      }

      Fliplet.Studio.emit('page-preview-send-event', {
        type: 'savePage'
      });

      Object.assign(widgetData, data);

      Fliplet.Hooks.run('componentEvent', {
        type: 'render',
        target: new Fliplet.Interact.ComponentNode(el)
      });
    };

    const debounceSave = debounce(saveChanges, 500, { leading: true });

    const studioEventHandler = () => {
      Fliplet.Studio.onEvent((event) => {
        const { type, payload } = event.detail;

        if (!editor || !tinymce.activeEditor || editor.id !== tinymce.activeEditor.id) {
          return;
        }

        const getExclusiveScriptIntent = (eventType, eventPayload) => {
          if (!eventPayload) return null;

          // Studio can send sub/sup in a few different shapes depending on toolbar implementation
          if (eventType === 'tinymce.applyFormat') {
            const fmt = (eventPayload.format || '').toString().toLowerCase();

            if (fmt === 'subscript' || fmt === 'superscript') return fmt;
          }

          if (eventType === 'tinymce.execCommand') {
            const cmd = (eventPayload.cmd || '').toString().toLowerCase();
            const value = (eventPayload.value || '').toString().toLowerCase();

            if (cmd === 'subscript') return 'subscript';
            if (cmd === 'superscript') return 'superscript';

            // Some toolbars use TinyMCE's toggle format command with the format name in value
            if (cmd === 'mcetoggleformat' && (value === 'subscript' || value === 'superscript')) return value;

            if (value === 'subscript' || value === 'superscript') return value;
          }

          return null;
        };

        const toggleExclusiveScript = (ed, intent) => {
          if (!ed || !intent) return false;

          const desired = intent.toLowerCase();
          const isSub = desired === 'subscript';
          const isSup = desired === 'superscript';

          if (!isSub && !isSup) return false;

          const isActive = (fmt, cmd) => {
            try {
              if (typeof ed.queryCommandState === 'function') {
                return !!ed.queryCommandState(cmd);
              }
            } catch (e) {
              /* no-op */
            }

            try {
              if (ed.formatter && typeof ed.formatter.match === 'function') {
                return !!ed.formatter.match(fmt);
              }
            } catch (e) {
              /* no-op */
            }

            return false;
          };

          const wasSub = isActive('subscript', 'Subscript');
          const wasSup = isActive('superscript', 'Superscript');
          const wasDesired = isSub ? wasSub : wasSup;
          const wasOnlyDesired = wasDesired && !(isSub ? wasSup : wasSub);

          // Always remove both first so we never end up with nested <sub><sup>...</sup></sub>
          try {
            if (ed.formatter && typeof ed.formatter.remove === 'function') {
              ed.formatter.remove('subscript', { value: null }, null, true);
              ed.formatter.remove('superscript', { value: null }, null, true);
            }
          } catch (e) {
            /* no-op */
          }

          // Toggle off if it was already the only active script format
          if (wasOnlyDesired) {
            lastScriptIntent = null;

            return true;
          }

          // Apply the desired one
          lastScriptIntent = desired;

          try {
            ed.execCommand(isSub ? 'Subscript' : 'Superscript');
          } catch (e) {
            try {
              if (ed.formatter && typeof ed.formatter.apply === 'function') {
                ed.formatter.apply(isSub ? 'subscript' : 'superscript');
              }
            } catch (err) {
              /* no-op */
            }
          }

          return true;
        };

        const ensureEditableRootWithCaret = (ed) => {
          try {
            const currentHtml = ed.getContent({ format: 'html' }).trim();
            const isEffectivelyEmpty = currentHtml === '' || currentHtml === '<p></p>' || currentHtml === '<p><br></p>';

            if (isEffectivelyEmpty) {
              ed.setContent('<p><span data-fl-caret-holder="1">\u200B</span></p>');

              const span = ed.dom.select('span[data-fl-caret-holder="1"]')[0];

              if (span) {
                ed.selection.select(span);
                ed.selection.collapse(true);
              }

              el.classList.remove('fl-text-empty');

              return true;
            }
          } catch (e) {
            /* no-op */
          }

          return false;
        };

        switch (type) {
          case 'tinymce.execCommand':
            if (!payload) break;
            editor = tinymce.activeEditor;
            editor.undoManager.transact(() => {
              // Clicking the Studio toolbar can blur the editor before the command is sent.
              // Cancel any pending "disable toolbar" action so the click can still apply styles.
              cancelPendingBlurDisable();
              Fliplet.Studio.emit('set-wysiwyg-status', true);
              editor.focus();
              ensureEditableRootWithCaret(editor);

              const intent = getExclusiveScriptIntent(type, payload);

              if (toggleExclusiveScript(editor, intent)) {
                editor.nodeChanged();

                return;
              }

              editor.execCommand(payload.cmd, payload.ui, payload.value);
              editor.nodeChanged();
            });
            break;
          case 'tinymce.applyFormat':
            editor = tinymce.activeEditor;
            editor.undoManager.transact(() => {
              cancelPendingBlurDisable();
              Fliplet.Studio.emit('set-wysiwyg-status', true);
              editor.focus();
              ensureEditableRootWithCaret(editor);

              const intent = getExclusiveScriptIntent(type, payload);

              if (toggleExclusiveScript(editor, intent)) {
                editor.nodeChanged();

                return;
              }

              editor.formatter.apply(payload.format, { value: payload.value });
              editor.nodeChanged();
            });
            break;
          case 'tinymce.removeFormat':
            editor = tinymce.activeEditor;
            editor.undoManager.transact(() => {
              cancelPendingBlurDisable();
              Fliplet.Studio.emit('set-wysiwyg-status', true);
              editor.focus();
              editor.formatter.remove(payload.format, { value: null }, null, true);
              editor.nodeChanged();
            });
            break;
          case 'widgetCancel':
            if (onBlur) {
              editor.hide();
            }

            break;
          default:
            break;
        }
      });
    };

    const attachEventHandler = () => {
      el.addEventListener('click', async() => {
        await initializeEditor();
        editor.show();

        // Update element highlight if there isn't already an inline element selected
        if (!document.querySelector(`[data-id="${widgetData.id}"] .mce-content-body [data-mce-selected="1"]`)) {
          scheduleHighlightUpdate(widgetData.id);
        }

        // When re-activating the widget after clicking elsewhere, force a toolbar sync.
        // This prevents Studio toolbar from showing stale colors while TinyMCE types default (or vice-versa).
        try {
          scheduleNodeChanged(editor);
        } catch (e) {
          /* no-op */
        }
      });
    };

    const initializeEditor = async() => {
      // Ensure the element has an ID
      if (!el.id) {
        el.id = 'text-widget-' + widgetData.id;
      }

      editor = tinymce.get(el.id);

      if (editor) {
        return editor;
      }

      return new Promise((resolve) => {
        let plugins = [
          'advlist', 'lists', 'link', 'image', 'charmap',
          'searchreplace', 'wordcount', 'insertdatetime', 'table'
        ];

        tinymce.init({
          target: el,
          inline: true,
          menubar: false,
          force_br_newlines: false,
          forced_root_block: 'p',
          object_resizing: false,
          verify_html: false,
          plugins,
          valid_styles: {
            '*': 'font-family,font-size,font-weight,font-style,text-decoration,text-align,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin,display,float,color,background,background-color,background-image,list-style-type,line-height,letter-spacing,width,height,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,position,opacity,top,left,right,bottom,overflow,z-index',
            img: 'text-align,margin-left,margin-right,display,float,width,height,background,background-color',
            table: 'border-color,width,height,font-size,font-weight,font-style,text-decoration,text-align,color,background,background-color,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin',
            tr: 'border-color,width,height,font-size,font-weight,font-style,text-decoration,text-align,color,background,background-color,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin',
            td: 'border-color,width,height,font-size,font-weight,font-style,text-decoration,text-align,color,background,background-color,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin',
            tbody: 'border-color,width,height,font-size,font-weight,font-style,text-decoration,text-align,color,background,background-color,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin',
            thead: 'border-color,width,height,font-size,font-weight,font-style,text-decoration,text-align,color,background,background-color,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin',
            tfoot: 'border-color,width,height,font-size,font-weight,font-style,text-decoration,text-align,color,background,background-color,min-width,max-width,min-height,max-height,border,border-top,border-bottom,border-left,border-right,padding,padding-left,padding-right,padding-top,padding-bottom,padding,margin-left,margin-right,margin-top,margin-bottom,margin'
          },
          valid_children: '+body[style],-font[face],div[br,#text],img,+span[div|section|ul|ol|form|header|footer|article|hr|table]',
          toolbar: [
            'formatselect | fontselect fontsizeselect |',
            'bold italic underline strikethrough | forecolor backcolor |',
            'alignleft aligncenter alignright alignjustify | bullist numlist outdent indent |',
            'blockquote subscript superscript | link table insertdatetime charmap hr |',
            'removeformat'
          ].join(' '),
          fontsize_formats: '8px 10px 12px 14px 16px 18px 24px 36px',
          setup: (ed) => {
            ed.on('init', () => {
              editor = ed;
              editors[widgetData.id] = ed;

              // Capture "default" colors from editor body to detect when user is on a default-styled line
              try {
                const body = ed.getBody();
                const cs = body ? window.getComputedStyle(body) : null;

                defaultColors.foreColor = normalizeColor(cs && cs.color);
                defaultColors.backColor = normalizeColor(cs && cs.backgroundColor);
                defaultFonts.fontFamily = normalizeFontFamily(cs && cs.fontFamily);
                defaultFonts.fontSize = normalizeFontSize(cs && cs.fontSize);
              } catch (e) {
                defaultColors.foreColor = null;
                defaultColors.backColor = null;
                defaultFonts.fontFamily = null;
                defaultFonts.fontSize = null;
              }

              // Removes position from Editor element.
              // TinyMCE adds the position style to place the toolbar absolute positioned
              // We hide the toolbar and the TinyMCE feature is causing problems
              el.style.cssText = el.style.cssText.replace(/position[^;]+;?/g, '');

              // To process image selection after image is loaded
              scheduleHighlightUpdate();

              resolve();
            });

            // Keep forecolor/backcolor sticky across new paragraphs (Enter) and clicks into empty blocks
            ed.on('keydown', (evt) => {
              try {
                if (evt && (evt.key === 'Enter' || evt.keyCode === 13)) {
                  setCaretMoveIntent('enter');
                  setTimeout(() => applyStickyColorsIfNeeded(ed), 0);
                  setTimeout(() => applyStickyFontsIfNeeded(ed), 0);
                }
              } catch (e) {
                /* no-op */
              }
            });

            ed.on('click', () => {
              try {
                setCaretMoveIntent('click');
                scheduleNodeChanged(ed);
              } catch (e) {
                /* no-op */
              }
            });

            ed.on('touchend', () => {
              try {
                setCaretMoveIntent('click');
                scheduleNodeChanged(ed);
              } catch (e) {
                /* no-op */
              }
            });

            ed.on('keyup', (evt) => {
              try {
                // Sync toolbar state for navigation keys (caret moves without content change)
                const key = evt && (evt.key || evt.keyCode);
                const navKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
                const isNav = navKeys.includes(key)
                  || key === 37 || key === 38 || key === 39 || key === 40
                  || key === 36 || key === 35 || key === 33 || key === 34;

                if (isNav) {
                  scheduleNodeChanged(ed);
                }
              } catch (e) {
                /* no-op */
              }
            });

            ed.on('mouseup', () => {
              try {
                setCaretMoveIntent('click');
                setTimeout(() => {
                  // Ensure Studio toolbar gets a fresh snapshot for the new caret position
                  scheduleNodeChanged(ed);

                  applyStickyColorsIfNeeded(ed);
                  applyStickyFontsIfNeeded(ed);
                }, 0);
              } catch (e) {
                /* no-op */
              }
            });

            ed.on('change', () => {
              scheduleHighlightUpdate(widgetData.id);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('input', () => {
              scheduleHighlightUpdate(widgetData.id);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('focus', () => {
              cancelPendingBlurDisable();

              // Ensure there's a valid root block and a caret position when starting from empty

              try {
                const currentHtml = ed.getContent({ format: 'html' }).trim();
                const isEffectivelyEmpty = currentHtml === '' || currentHtml === '<p></p>' || currentHtml === '<p><br></p>';

                if (!widgetData.html || isEffectivelyEmpty) {
                  // Set a default empty paragraph so formats/tables can be applied at the caret
                  ed.setContent('<p><br></p>');

                  const body = ed.getBody();

                  if (body && body.firstChild) {
                    ed.selection.setCursorLocation(body.firstChild, 0);
                  }

                  el.classList.remove('fl-text-empty');
                }
              } catch (e) {
                // Fallback to removing empty state if anything goes wrong
                el.classList.remove('fl-text-empty');
              }

              el.closest('[draggable="true"]').setAttribute('draggable', 'false');
              Fliplet.Studio.emit('show-toolbar', true);
              Fliplet.Studio.emit('set-wysiwyg-status', true);

              // Force a nodeChange sync on focus so Studio's TinyMCE toolbar can enable buttons
              // even when the selection is collapsed (no text selected).
              try {
                scheduleNodeChanged(ed);

                // Some browsers finalize the caret position after focus; re-sync once more shortly after.
                setTimeout(() => scheduleNodeChanged(ed), 50);
              } catch (e) {
                /* no-op */
              }
            });

            ed.on('blur', () => {
              if (tinymce.activeEditor.getContent() === '') {
                el.classList.add('fl-text-empty');
              } else {
                el.classList.remove('fl-text-empty');
              }

              onBlur = true;
              el.closest('[draggable="false"]').setAttribute('draggable', 'true');

              // Delay disabling the Studio toolbar.
              // When users click the toolbar without selecting text, TinyMCE blurs first and the toolbar
              // can get disabled before the click is processed. A short delay keeps the toolbar usable,
              // and we cancel it if focus returns or a toolbar command is received.
              cancelPendingBlurDisable();
              blurDisableTimer = setTimeout(() => {
                blurDisableTimer = null;
                Fliplet.Studio.emit('set-wysiwyg-status', false);
              }, 150);

              if (!isInitialized) {
                return;
              }

              // Always save changes on blur
              debounceSave();
            });

            ed.on('nodeChange', (e) => {
              /* Mirror TinyMCE selection and styles to Studio TinyMCE instance */

              // Track the last active colors so they can be re-applied when entering a new/empty block
              syncStickyColorsFromCaret(ed);
              syncStickyFontsFromCaret(ed);

              // Enforce mutual exclusivity for subscript/superscript.
              // Some existing content can end up with nested <sub><sup>...</sup></sub> (or vice-versa),
              // which makes Studio show both buttons as active. Normalize to only one.
              if (!isFixingScriptState) {
                try {
                  const hasSub = ed.formatter && typeof ed.formatter.match === 'function'
                    ? !!ed.formatter.match('subscript')
                    : false;
                  const hasSup = ed.formatter && typeof ed.formatter.match === 'function'
                    ? !!ed.formatter.match('superscript')
                    : false;

                  if (hasSub && hasSup) {
                    isFixingScriptState = true;

                    let keep = lastScriptIntent;

                    if (!keep) {
                      // Pick whichever tag is closest to the caret (most specific)
                      let cur = null;

                      try {
                        cur = ed.selection && typeof ed.selection.getStart === 'function'
                          ? ed.selection.getStart(true)
                          : null;
                      } catch (err) {
                        cur = null;
                      }

                      while (cur && cur !== ed.getBody()) {
                        const name = (cur.nodeName || '').toLowerCase();

                        if (name === 'sub') {
                          keep = 'subscript';
                          break;
                        }

                        if (name === 'sup') {
                          keep = 'superscript';
                          break;
                        }

                        cur = cur.parentNode;
                      }
                    }

                    ed.undoManager.transact(() => {
                      ed.formatter.remove('subscript', { value: null }, null, true);
                      ed.formatter.remove('superscript', { value: null }, null, true);

                      if (keep === 'subscript' || keep === 'superscript') {
                        ed.formatter.apply(keep);
                      }
                    });

                    isFixingScriptState = false;
                  }
                } catch (err) {
                  isFixingScriptState = false;
                }
              }

              // Update element highlight if there isn't already an inline element selected
              if (isInitialized
                && !document.querySelector(`[data-id="${widgetData.id}"] .mce-content-body [data-mce-selected="1"]`)) {
                scheduleHighlightUpdate(widgetData.id);
              }

              // Pick the nearest meaningful block element for correct format labeling (e.g., inside tables)
              let blockEl;
              const startNode = (editor.selection && typeof editor.selection.getStart === 'function')
                ? editor.selection.getStart(true)
                : e.element;

              // Compute caret styles for Studio toolbar sync.
              // Using the selection start is more accurate than e.element, especially for collapsed selections.
              let styleTarget = startNode;

              if (styleTarget && styleTarget.nodeType === 3) {
                styleTarget = styleTarget.parentElement;
              }

              if (!styleTarget || styleTarget.nodeType !== 1) {
                styleTarget = e.element;
              }

              const computed = window.getComputedStyle(styleTarget);
              const fontFamily = computed && computed.fontFamily ? computed.fontFamily : '';
              const fontSize = computed && computed.fontSize ? computed.fontSize : '';

              // For toolbar mirroring:
              // - When caret is on actual content, mirror inline styles (real formatting).
              // - When caret is on an empty/new line, mirror TinyMCE command state (what will be typed next).
              const inlineColors = readActiveColors(ed);
              const isEmptyCaretBlock = isEmptyBlockAtCaret(ed);
              const cmdColors = isEmptyCaretBlock ? readCommandColors(ed) : { foreColor: null, backColor: null };
              const activeColors = {
                foreColor: inlineColors.foreColor || cmdColors.foreColor,
                backColor: inlineColors.backColor || cmdColors.backColor
              };

              debugLog('nodeChange', {
                isEmptyCaretBlock,
                lastCaretMoveIntent,
                inlineColors,
                cmdColors,
                activeColors,
                stickyColors: { foreColor: stickyColors.foreColor, backColor: stickyColors.backColor },
                defaultColors: { foreColor: defaultColors.foreColor, backColor: defaultColors.backColor }
              });

              const computedColor = normalizeColor(computed && computed.color);
              // If TinyMCE reports a "last used" command color even though the caret is actually at default,
              // force the toolbar mirror back to default using computed color as ground truth.
              // This fixes cases where typing is default but Studio toolbar still shows the previous color.
              const isDefaultCaretColor = !!(defaultColors.foreColor && computedColor && computedColor === defaultColors.foreColor);

              if (isDefaultCaretColor && !inlineColors.foreColor) {
                activeColors.foreColor = null;
              }

              const defaultForeColor = defaultColors.foreColor || computedColor || '';

              // Always send explicit "default" values when no active format is present.
              // Studio's toolbar tends to keep the last chosen color unless it can read a concrete value
              // at the caret/selection.
              const caretColor = activeColors.foreColor || defaultForeColor || 'inherit';
              const caretBg = activeColors.backColor || 'transparent';

              const caretColorInline = activeColors.foreColor || defaultForeColor;
              const caretBgInline = activeColors.backColor || 'transparent';

              blockEl = editor.dom.getParent(startNode, 'p,h1,h2,h3,h4,h5,h6,pre,blockquote,li')
                || editor.dom.getParent(startNode, 'td,th,div')
                || null;

              let mirrorHtml;

              if (blockEl) {
                const tagName = (blockEl.tagName || '').toLowerCase();
                let tableEl = null;

                // Important: Studio's toolbar state (e.g. list styles from advlist) relies on
                // the surrounding list/table context. Mirroring only the <li> drops the
                // parent <ol>/<ul> (where list-style-type is set), so the active option can't
                // be detected and the dropdown shows no selected item.
                let rootEl = blockEl;

                if (tagName === 'td' || tagName === 'th') {
                  if (blockEl && typeof blockEl.closest === 'function') {
                    tableEl = blockEl.closest('table');
                  } else {
                    tableEl = editor.dom.getParent(blockEl, 'table');
                  }

                  rootEl = tableEl || blockEl;
                } else if (tagName === 'li') {
                  const listEl = (blockEl && typeof blockEl.closest === 'function')
                    ? blockEl.closest('ol,ul')
                    : editor.dom.getParent(blockEl, 'ol,ul');

                  // If the list is inside a table cell, keep table context; otherwise keep list context
                  const cellEl = (blockEl && typeof blockEl.closest === 'function')
                    ? blockEl.closest('td,th')
                    : editor.dom.getParent(blockEl, 'td,th');

                  if (cellEl) {
                    if (cellEl && typeof cellEl.closest === 'function') {
                      tableEl = cellEl.closest('table');
                    } else {
                      tableEl = editor.dom.getParent(cellEl, 'table');
                    }

                    rootEl = tableEl || listEl || blockEl;
                  } else {
                    rootEl = listEl || blockEl;
                  }
                }

                // Studio's toolbar buttons (tox) get disabled when it can't map the current caret/selection
                // to an editable position. Selecting a block element is not enough for a collapsed selection,
                // so we insert a lightweight caret marker in the mirrored HTML at the actual caret position.
                const getNodePath = (root, node) => {
                  const path = [];
                  let cur = node;

                  while (cur && cur !== root) {
                    const parent = cur.parentNode;

                    if (!parent) break;
                    const idx = Array.prototype.indexOf.call(parent.childNodes, cur);

                    path.push(idx);
                    cur = parent;
                  }

                  return cur === root ? path.reverse() : null;
                };

                const getNodeByPath = (root, path) => {
                  let cur = root;

                  for (const idx of path) {
                    if (!cur || !cur.childNodes || typeof cur.childNodes[idx] === 'undefined') return null;
                    cur = cur.childNodes[idx];
                  }

                  return cur;
                };

                const rootClone = rootEl.cloneNode(true);

                // Studio's toolbar sometimes reads state from the selected/root element, not our caret marker.
                // Apply the mirror element class to the root as well so colors/fonts can be inferred reliably.
                rootClone.classList.add(MIRROR_ROOT_CLASS);
                rootClone.classList.add(MIRROR_ELEMENT_CLASS);

                const insertCaretMarker = () => {
                  let rng = null;

                  try {
                    rng = editor.selection && typeof editor.selection.getRng === 'function'
                      ? editor.selection.getRng()
                      : null;
                  } catch (err) {
                    rng = null;
                  }

                  const container = rng ? rng.startContainer : null;
                  const offset = rng ? rng.startOffset : 0;

                  // Ensure we have a node inside rootEl
                  let targetNode = container || startNode;
                  let targetOffset = offset;

                  if (targetNode && targetNode.nodeType === 3 && targetNode.parentNode) {
                    // keep as-is
                  } else if (targetNode && targetNode.nodeType !== 1 && targetNode.parentNode) {
                    // normalize to an element node if it's not an element/text node
                    targetNode = targetNode.parentNode;
                    targetOffset = 0;
                  }

                  if (!targetNode || !rootEl.contains(targetNode)) {
                    targetNode = blockEl;
                    targetOffset = 0;
                  }

                  const path = getNodePath(rootEl, targetNode);
                  const cloneTarget = path ? getNodeByPath(rootClone, path) : null;

                  const markerEl = document.createElement('span');

                  markerEl.classList.add(MIRROR_ELEMENT_CLASS);
                  markerEl.setAttribute('data-fl-mirror-caret', '1');
                  // Studio's toolbar state for colors is more reliable when the mirrored HTML contains
                  // inline styles at the caret (not only a stylesheet). This also ensures that clicking
                  // into a default-styled table cell resets the toolbar color indicators.

                  try {
                    markerEl.style.color = caretColorInline;
                    markerEl.style.backgroundColor = caretBgInline;
                  } catch (e) {
                    /* no-op */
                  }

                  markerEl.appendChild(document.createTextNode('\u200B'));

                  if (!cloneTarget) {
                    rootClone.classList.add(MIRROR_ELEMENT_CLASS);

                    return;
                  }

                  // Insert the marker at the caret position
                  if (cloneTarget.nodeType === 3) {
                    const text = cloneTarget.nodeValue || '';
                    const safeOffset = Math.max(0, Math.min(targetOffset, text.length));
                    const before = text.slice(0, safeOffset);
                    const after = text.slice(safeOffset);
                    const parent = cloneTarget.parentNode;

                    if (!parent) {
                      rootClone.classList.add(MIRROR_ELEMENT_CLASS);

                      return;
                    }

                    const frag = document.createDocumentFragment();

                    if (before) frag.appendChild(document.createTextNode(before));
                    frag.appendChild(markerEl);
                    if (after) frag.appendChild(document.createTextNode(after));

                    parent.replaceChild(frag, cloneTarget);

                    return;
                  }

                  if (cloneTarget.nodeType === 1) {
                    const nodes = cloneTarget.childNodes || [];
                    const safeIndex = Math.max(0, Math.min(targetOffset, nodes.length));

                    if (safeIndex >= nodes.length) {
                      cloneTarget.appendChild(markerEl);
                    } else {
                      cloneTarget.insertBefore(markerEl, nodes[safeIndex]);
                    }

                    return;
                  }

                  rootClone.classList.add(MIRROR_ELEMENT_CLASS);
                };

                // Also put the same styles on the root clone. This acts as a fallback for Studio toolbars
                // that determine color values from the root/selection element rather than the caret marker.
                try {
                  rootClone.style.color = caretColorInline;
                  rootClone.style.backgroundColor = caretBgInline;
                } catch (e) {
                  /* no-op */
                }

                insertCaretMarker();

                mirrorHtml = rootClone.outerHTML;
              } else {
                mirrorHtml = e.parents.length
                  ? e.parents[e.parents.length - 1].outerHTML
                  : e.element.outerHTML;
              }

              // Send content to Studio
              Fliplet.Studio.emit('tinymce', {
                message: 'tinymceNodeChange',
                payload: {
                  html: mirrorHtml,
                  styles: `
                    .${MIRROR_ELEMENT_CLASS},
                    .${MIRROR_ROOT_CLASS} {
                      font-family: ${fontFamily};
                      font-size: ${fontSize};
                      color: ${caretColor};
                      background-color: ${caretBg};
                    }
                  `
                }
              });

              // If the caret is now in a fresh empty block, re-apply the last active colors
              // so subsequent typing keeps the selected colors.
              applyStickyColorsIfNeeded(ed);
              applyStickyFontsIfNeeded(ed);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('BeforeUnload', saveChanges);
          }
        });
      });
    };

    const init = async() => {
      if (!widgetData.html) {
        el.classList.add('fl-text-empty');
      } else {
        el.classList.remove('fl-text-empty');
      }

      if (getMode() !== 'interact') {
        Fliplet.Widget.initializeChildren(el);
        cleanUpContent();
        Fliplet.Widget.initializeChildren(el);

        if (!isDev) {
          return;
        }
      }

      try {
        await initializeEditor();
        isInitialized = true;
        editor.hide();

        studioEventHandler();
        attachEventHandler();
      } catch (error) {
        /* no-op */
      }
    };

    init();
  }, {
    supportsDynamicContext: true
  });

  Fliplet.Widget.register('Text', () => ({
    get: (id) => editors[id]
  }));
})();
