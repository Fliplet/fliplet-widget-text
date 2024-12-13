this["Fliplet"] = this["Fliplet"] || {};
this["Fliplet"]["Widget"] = this["Fliplet"]["Widget"] || {};
this["Fliplet"]["Widget"]["Templates"] = this["Fliplet"]["Widget"]["Templates"] || {};

this["Fliplet"]["Widget"]["Templates"]["templates.build.content"] = Handlebars.template({"1":function(container,depth0,helpers,partials,data) {
    return "  <p class=\"fl-text-placeholder\">Click here to start typing...</p>\r\n";
},"3":function(container,depth0,helpers,partials,data) {
    return "  <p>&nbsp;</p>\r\n";
},"compiler":[7,">= 4.0.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, helper, options, buffer = "";

  stack1 = ((helper = (helper = helpers.isInteractable || (depth0 != null ? depth0.isInteractable : depth0)) != null ? helper : helpers.helperMissing),(options={"name":"isInteractable","hash":{},"fn":container.program(1, data, 0),"inverse":container.program(3, data, 0),"data":data}),(typeof helper === "function" ? helper.call(depth0 != null ? depth0 : (container.nullContext || {}),options) : helper));
  if (!helpers.isInteractable) { stack1 = helpers.blockHelperMissing.call(depth0,stack1,options)}
  if (stack1 != null) { buffer += stack1; }
  return buffer;
},"useData":true});