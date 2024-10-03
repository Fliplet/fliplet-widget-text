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
    let lastSavedHtml;

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

    const saveChanges = async () => {
      if (getMode() === 'preview') {
        return;
      }

      const editorContent = editor?.getContent?.();

      const data = {
        // Weak comparison to allow empty string to be saved
        html: editorContent != null ? editorContent : widgetData.html
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

      const replacedHTML = doc.body.innerHTML;

      // Pass HTML content through a hook so any JavaScript that has changed the HTML
      // can use this to revert the HTML changes
      const html = await Fliplet.Hooks.run('beforeSavePageContent', replacedHTML);
      
      data.html = [html].flat().at(-1) || replacedHTML;
      
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

        switch (type) {
          case 'tinymce.execCommand':
            if (!payload) break;
            tinymce.activeEditor.execCommand(payload.cmd, payload.ui, payload.value);
            break;
          case 'tinymce.applyFormat':
            editor = tinymce.activeEditor;
            editor.undoManager.transact(() => {
              editor.focus();
              editor.formatter.apply(payload.format, { value: payload.value });
              editor.nodeChanged();
            });
            break;
          case 'tinymce.removeFormat':
            editor = tinymce.activeEditor;
            editor.undoManager.transact(() => {
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
        }
      });
    };

    const attachEventHandler = () => {
      el.addEventListener('click', async () => {
        await initializeEditor();
        editor.show();

        // Update element highlight if there isn't already an inline element selected
        if (!document.querySelector(`[data-id="${widgetData.id}"] .mce-content-body [data-mce-selected="1"]`)) {
          Fliplet.Widget.updateHighlightDimensions(widgetData.id);
        }
      });
    };

    const initializeEditor = async () => {
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

              // Removes position from Editor element.
              // TinyMCE adds the position style to place the toolbar absolute positioned
              // We hide the toolbar and the TinyMCE feature is causing problems
              el.style.cssText = el.style.cssText.replace(/position[^;]+;?/g, '');

              // To process image selection after image is loaded
              Fliplet.Widget.updateHighlightDimensions();

              resolve();
            });

            ed.on('change', () => {
              Fliplet.Widget.updateHighlightDimensions(widgetData.id);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('input', () => {
              Fliplet.Widget.updateHighlightDimensions(widgetData.id);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('focus', () => {
              if (!widgetData.html) {
                el.innerHTML = '';
                el.classList.remove('fl-text-empty');
              }

              el.closest('[draggable="true"]').setAttribute('draggable', 'false');
              Fliplet.Studio.emit('show-toolbar', true);
              Fliplet.Studio.emit('set-wysiwyg-status', true);
            });

            ed.on('blur', () => {
              if (tinymce.activeEditor.getContent() === '') {
                el.classList.add('fl-text-empty');
                editor.hide();
              } else {
                el.classList.remove('fl-text-empty');
              }

              onBlur = true;
              el.closest('[draggable="false"]').setAttribute('draggable', 'true');

              Fliplet.Studio.emit('set-wysiwyg-status', false);

              if (!isInitialized) {
                return;
              }

              // Always save changes on blur
              debounceSave();
            });

            ed.on('nodeChange', (e) => {
              /* Mirror TinyMCE selection and styles to Studio TinyMCE instance */

              // Update element highlight if there isn't already an inline element selected
              if (isInitialized
                && !document.querySelector(`[data-id="${widgetData.id}"] .mce-content-body [data-mce-selected="1"]`)) {
                Fliplet.Widget.updateHighlightDimensions(widgetData.id);
              }

              // Mark e.element and the last element of e.parents with classes
              e.element.classList.add(MIRROR_ELEMENT_CLASS);

              if (e.parents.length) {
                e.parents[e.parents.length - 1].classList.add(MIRROR_ROOT_CLASS);
              }

              const { fontFamily, fontSize } = window.getComputedStyle(e.element);

              // Send content to Studio
              Fliplet.Studio.emit('tinymce', {
                message: 'tinymceNodeChange',
                payload: {
                  html: e.parents.length
                    ? e.parents[e.parents.length - 1].outerHTML
                    : e.element.outerHTML,
                  styles: `
                    .${MIRROR_ELEMENT_CLASS} {
                      font-family: ${fontFamily};
                      font-size: ${fontSize};
                    }
                  `
                }
              });

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });
          }
        });
      });
    };

    const init = async () => {
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
        console.error('Failed to initialize editor:', error);
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