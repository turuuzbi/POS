import adjustments from "./adjustments.json";
import auth from "./auth.json";
import categories from "./categories.json";
import common from "./common.json";
import dashboard from "./dashboard.json";
import devices from "./devices.json";
import errors from "./errors.json";
import importExport from "./importExport.json";
import inventory from "./inventory.json";
import nav from "./nav.json";
import picker from "./picker.json";
import pos from "./pos.json";
import preferences from "./preferences.json";
import products from "./products.json";
import purchasing from "./purchasing.json";
import roles from "./roles.json";
import states from "./states.json";
import stocktakes from "./stocktakes.json";
import taxClasses from "./taxClasses.json";
import units from "./units.json";
import validation from "./validation.json";

/** One file per area, so features can add messages without touching each other's. */
const messages = {
  adjustments,
  auth,
  categories,
  common,
  dashboard,
  devices,
  errors,
  importExport,
  inventory,
  nav,
  picker,
  pos,
  preferences,
  products,
  purchasing,
  roles,
  states,
  stocktakes,
  taxClasses,
  units,
  validation,
};

export default messages;
