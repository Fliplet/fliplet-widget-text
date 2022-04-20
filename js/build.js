(function() {
  var editors = {};

  Fliplet.Widget.instance('text', function(widgetData) {
    var editor;
    var MIRROR_ELEMENT_CLASS = 'fl-mirror-element';
    var MIRROR_ROOT_CLASS = 'fl-mirror-root';
    var PLACEHOLDER_CLASS = 'fl-text-placeholder';
    var WIDGET_INSTANCE_SELECTOR = '[data-fl-widget-instance]';
    var $WYSIWYG_SELECTOR = $('[data-text-id="' + widgetData.id + '"]');
    var debounceSave = _.debounce(saveChanges, 500, { leading: true });
    var mode = Fliplet.Env.get('mode');
    var isDev = Fliplet.Env.get('development');
    var isInitialized = false;
    var hasValue = !!widgetData.html;
    var onBlur = false;
    var contentTemplate = Fliplet.Widget.Templates['templates.build.content'];
    var lastSavedHtml;

    function cleanUpContent() {
      // Remove any existing markers
      $('.' + MIRROR_ELEMENT_CLASS).removeClass(MIRROR_ELEMENT_CLASS);
      $('.' + MIRROR_ROOT_CLASS).removeClass(MIRROR_ROOT_CLASS);
      $('.' + PLACEHOLDER_CLASS).removeClass(PLACEHOLDER_CLASS);
      $('.fl-wysiwyg-text .fl-wysiwyg-text.mce-content-body').replaceWith(function() {
        return $(this).contents();
      });

      // Remove empty class attributes
      $('[class=""]').removeAttr('class');
    }

    function replaceWidgetInstances($html) {
      $html.find(WIDGET_INSTANCE_SELECTOR).replaceWith(function() {
        var widgetInstanceId = $(this).data('id');

        return '{{{widget ' + widgetInstanceId + '}}}';
      });

      return $html;
    }

    function saveChanges() {
      if ($WYSIWYG_SELECTOR.find('.' + PLACEHOLDER_CLASS).length) {
        return;
      }

      cleanUpContent();

      var data = {
        html: editor && typeof editor.getContent === 'function'
          ? editor.getContent()
          : widgetData.html
      };

      onBlur = false;

      var $html = $('<div>' + data.html + '</div>').clone();
      var $replacedHTML = replaceWidgetInstances($html);

      // Pass HTML content through a hook so any JavaScript that has changed the HTML
      // can use this to revert the HTML changes
      return Fliplet.Hooks.run('beforeSavePageContent', $replacedHTML.html())
        .then(function(html) {
          if (!Array.isArray(html) || !html.length) {
            html = [$replacedHTML.html()];
          }

          return html[html.length - 1];
        }).then(function(html) {
          data.html = html;

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

          return Fliplet.Env.get('development')
            ? Promise.resolve()
            : Fliplet.API.request({
              url: 'v1/widget-instances/' + widgetData.id,
              method: 'PUT',
              data: data
            }).then(function() {
              Fliplet.Studio.emit('page-preview-send-event', {
                type: 'savePage'
              });

              _.assignIn(widgetData, data);
            });
        });
    }

    function studioEventHandler() {
      Fliplet.Studio.onEvent(function(event) {
        var eventDetail = event.detail;

        if (!editor || !tinymce.activeEditor || editor.id !== tinymce.activeEditor.id) {
          return;
        }

        switch (eventDetail.type) {
          case 'tinymce.execCommand':
            if (!eventDetail.payload) {
              break;
            }

            var cmd = eventDetail.payload.cmd;
            var ui = eventDetail.payload.ui;
            var value = eventDetail.payload.value;

            tinymce.activeEditor.execCommand(cmd, ui, value);

            break;
          case 'tinymce.applyFormat':
            editor = tinymce.activeEditor;
            editor.undoManager.transact(function() {
              editor.focus();
              editor.formatter.apply(
                eventDetail.payload.format,
                {
                  value: eventDetail.payload.value
                }
              );
              editor.nodeChanged();
            });

            break;
          case 'tinymce.removeFormat':
            editor = tinymce.activeEditor;
            editor.undoManager.transact(function() {
              editor.focus();
              editor.formatter.remove(
                eventDetail.payload.format,
                {
                  value: null
                }, null, true
              );
              editor.nodeChanged();
            });

            break;
          case 'widgetCancel':
            if (onBlur) {
              // Remove tinymce on blur
              editor.hide();
            }

            break;
          default:
            break;
        }
      });
    }

    function attachEventHandler() {
      $WYSIWYG_SELECTOR.on('click', function() {
        initializeEditor().then(function() {
          editor.show();
        });

        // Update element highlight if there isn't already an inline element selected
        if (!$('[data-id="' + widgetData.id + '"] .mce-content-body [data-mce-selected="1"]').length) {
          Fliplet.Widget.updateHighlightDimensions(widgetData.id);
        }
      });
    }

    function initializeEditor() {
      var $element = $WYSIWYG_SELECTOR;

      editor = tinymce.get($element.attr('id'));

      if (editor) {
        return Promise.resolve(editor);
      }

      return new Promise(function(resolve) {
        $element.tinymce({
          inline: true,
          menubar: false,
          force_br_newlines: false,
          force_p_newlines: true,
          forced_root_block: 'p',
          object_resizing: false,
          verify_html: false,
          plugins: [
            'advlist lists link image charmap hr',
            'searchreplace wordcount insertdatetime table textcolor colorpicker',
            'noneditable'
          ],
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
          setup: function(ed) {
            ed.on('init', function() {
              editor = ed;
              editors[widgetData.id] = ed;

              // Removes position from Editor element.
              // TinyMCE adds the position style to place the toolbar absolute positioned
              // We hide the toolbar and the TinyMCE feature is causing problems
              $element.attr('style', function(i, style) {
                return style.replace(/position[^;]+;?/g, '');
              });

              // To process image selection after image is loaded
              Fliplet.Widget.updateHighlightDimensions();

              resolve();
            });

            ed.on('change', function() {
              Fliplet.Widget.updateHighlightDimensions(widgetData.id);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('input', function() {
              Fliplet.Widget.updateHighlightDimensions(widgetData.id);

              hasValue = !!tinymce.activeEditor.getContent();

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('focus', function() {
              if (!hasValue) {
                $element.text('');
              }

              $element.parents('[draggable="true"]').attr('draggable', false);
              Fliplet.Studio.emit('show-toolbar', true);
              Fliplet.Studio.emit('set-wysiwyg-status', true);
            });

            ed.on('blur', function() {
              if (tinymce.activeEditor.getContent() === '') {
                insertPlaceholder();
                editor.hide();

                hasValue = false;

                return;
              }

              onBlur = true;
              $element.parents('[draggable="false"]').attr('draggable', true);

              Fliplet.Studio.emit('set-wysiwyg-status', false);

              if (!isInitialized) {
                return;
              }

              // Save changes
              debounceSave();
            });

            ed.on('nodeChange', function(e) {
              /* Mirror TinyMCE selection and styles to Studio TinyMCE instance */

              // Update element highlight if there isn't already an inline element selected
              if (isInitialized
                && !$('[data-id="' + widgetData.id + '"] .mce-content-body [data-mce-selected="1"]').length) {
                Fliplet.Widget.updateHighlightDimensions(widgetData.id);
              }

              // Mark e.element and the last element of e.parents with classes
              e.element.classList.add(MIRROR_ELEMENT_CLASS);

              if (e.parents.length) {
                e.parents[e.parents.length - 1].classList.add(MIRROR_ROOT_CLASS);
              }

              var fontFamily = window.getComputedStyle(e.element).getPropertyValue('font-family');
              var fontSize = window.getComputedStyle(e.element).getPropertyValue('font-size');

              // Send content to Studio
              Fliplet.Studio.emit('tinymce', {
                message: 'tinymceNodeChange',
                payload: {
                  html: e.parents.length ?
                    e.parents[e.parents.length - 1].outerHTML :
                    e.element.outerHTML,
                  styles: [
                    '.' + MIRROR_ELEMENT_CLASS + ' {',
                    '\tfont-family: ' + fontFamily + ';',
                    '\tfont-size: ' + fontSize + ';',
                    '}'
                  ].join('\n')
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
    }

    function registerHandlebarsHelpers() {
      Handlebars.registerHelper('isInteractable', function(options) {
        var result = mode === 'interact' || isDev;

        if (result === false) {
          return options.inverse(this);
        }

        return options.fn(this);
      });
    }

    function insertPlaceholder() {
      var contentHTML = contentTemplate();

      $WYSIWYG_SELECTOR.html(contentHTML);
    }

    function init() {
      registerHandlebarsHelpers();

      if (!widgetData.html && !$WYSIWYG_SELECTOR.find('.' + PLACEHOLDER_CLASS).length) {
        insertPlaceholder();
      }

      if (mode !== 'interact') {
        cleanUpContent();

        if (!isDev) {
          return;
        }
      }

      initializeEditor()
        .then(function() {
          isInitialized = true;
          editor.hide();

          studioEventHandler();
          attachEventHandler();
        });
    }

    init();
  });

  Fliplet.Widget.register('Text', function() {
    return {
      get: function(id) {
        return editors[id];
      }
    };
  });
})();
