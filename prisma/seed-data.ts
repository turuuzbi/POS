/**
 * Demo catalog for a Mongolian neighbourhood grocery (дэлгүүр): mostly
 * weighed goods (meat, vegetables, fruit, sweets by the kilo) plus packaged
 * goods with EAN-13 barcodes and a few products with variants.
 * Prices are whole tögrög, tax-inclusive (НӨАТ 10%).
 */

export type SeedUnit = "PIECE" | "KG" | "LITER";

export interface SeedVariant {
  /** Variant label, e.g. "0.5 л"; omit for single-variant products. */
  name?: string;
  sku: string;
  priceMnt: number;
  costMnt: number;
  /** Scale PLU code (weighed goods). */
  plu?: string;
  /** Item number used to derive a valid EAN-13 (packaged goods). */
  ean?: number;
}

export interface SeedProduct {
  name: string;
  category: string;
  unit: SeedUnit;
  type?: "STANDARD" | "SERVICE";
  optionName?: string;
  variants: SeedVariant[];
}

export const SEED_CATEGORIES: { name: string; color: string }[] = [
  { name: "Мах, махан бүтээгдэхүүн", color: "red" },
  { name: "Хүнсний ногоо", color: "green" },
  { name: "Жимс", color: "orange" },
  { name: "Сүү, сүүн бүтээгдэхүүн", color: "sky" },
  { name: "Талх, нарийн боов", color: "amber" },
  { name: "Ундаа", color: "blue" },
  { name: "Чихэр, амттан", color: "pink" },
  { name: "Ахуйн бараа", color: "violet" },
  { name: "Үйлчилгээ", color: "slate" },
];

const kg = (
  name: string,
  category: string,
  sku: string,
  plu: string,
  priceMnt: number,
  costMnt: number,
): SeedProduct => ({ name, category, unit: "KG", variants: [{ sku, plu, priceMnt, costMnt }] });

const piece = (
  name: string,
  category: string,
  sku: string,
  ean: number,
  priceMnt: number,
  costMnt: number,
): SeedProduct => ({ name, category, unit: "PIECE", variants: [{ sku, ean, priceMnt, costMnt }] });

const MEAT = "Мах, махан бүтээгдэхүүн";
const VEG = "Хүнсний ногоо";
const FRUIT = "Жимс";
const DAIRY = "Сүү, сүүн бүтээгдэхүүн";
const BAKERY = "Талх, нарийн боов";
const DRINKS = "Ундаа";
const SWEETS = "Чихэр, амттан";
const HOUSEHOLD = "Ахуйн бараа";
const SERVICES = "Үйлчилгээ";

export const SEED_PRODUCTS: SeedProduct[] = [
  // Weighed meat — sold by the kilo from the counter scale.
  kg("Үхрийн мах", MEAT, "MEAT-BEEF", "101", 22_000, 17_500),
  kg("Хонины мах", MEAT, "MEAT-MUTTON", "102", 18_000, 14_200),
  kg("Ямааны мах", MEAT, "MEAT-GOAT", "103", 15_000, 11_800),
  kg("Тахианы мах", MEAT, "MEAT-CHICKEN", "104", 14_500, 11_000),
  kg("Үхрийн татсан мах", MEAT, "MEAT-MINCE", "105", 24_000, 18_900),
  kg("Гахайн мах", MEAT, "MEAT-PORK", "106", 19_500, 15_300),
  // Weighed vegetables.
  kg("Төмс", VEG, "VEG-POTATO", "201", 2_200, 1_500),
  kg("Лууван", VEG, "VEG-CARROT", "202", 2_800, 1_900),
  kg("Байцаа", VEG, "VEG-CABBAGE", "203", 2_500, 1_700),
  kg("Сонгино", VEG, "VEG-ONION", "204", 3_200, 2_200),
  kg("Улаан лооль", VEG, "VEG-TOMATO", "205", 9_800, 7_100),
  kg("Өргөст хэмх", VEG, "VEG-CUCUMBER", "206", 7_500, 5_400),
  kg("Сармис", VEG, "VEG-GARLIC", "207", 14_000, 10_200),
  // Weighed fruit.
  kg("Алим", FRUIT, "FRUIT-APPLE", "301", 8_500, 6_300),
  kg("Банана", FRUIT, "FRUIT-BANANA", "302", 7_900, 5_800),
  kg("Жүрж", FRUIT, "FRUIT-ORANGE", "303", 9_500, 7_000),
  kg("Усан үзэм", FRUIT, "FRUIT-GRAPE", "304", 16_000, 12_100),
  // Dairy: mostly packaged, cheese by weight.
  piece("Сүү 1 л", DAIRY, "DAIRY-MILK-1L", 1, 3_800, 2_950),
  piece("Тараг 0.5 л", DAIRY, "DAIRY-YOGURT-05", 2, 2_900, 2_200),
  piece("Цөцгий 200 г", DAIRY, "DAIRY-SOURCREAM-200", 3, 3_500, 2_650),
  piece("Цөцгийн тос 200 г", DAIRY, "DAIRY-BUTTER-200", 4, 9_800, 7_600),
  kg("Бяслаг", DAIRY, "DAIRY-CHEESE", "401", 32_000, 25_000),
  {
    name: "Өндөг",
    category: DAIRY,
    unit: "PIECE",
    optionName: "Савлагаа",
    variants: [
      { name: "10 ш", sku: "DAIRY-EGG-10", ean: 5, priceMnt: 6_500, costMnt: 5_100 },
      { name: "30 ш", sku: "DAIRY-EGG-30", ean: 6, priceMnt: 18_500, costMnt: 14_700 },
    ],
  },
  // Bakery.
  piece("Талх", BAKERY, "BAKERY-BREAD", 7, 2_800, 1_950),
  piece("Ороомог", BAKERY, "BAKERY-ROLL", 8, 3_500, 2_400),
  kg("Боорцог", BAKERY, "BAKERY-BOORTSOG", "501", 12_000, 8_400),
  // Drinks with size variants.
  {
    name: "Ус",
    category: DRINKS,
    unit: "PIECE",
    optionName: "Хэмжээ",
    variants: [
      { name: "0.5 л", sku: "DRINK-WATER-05", ean: 9, priceMnt: 1_200, costMnt: 800 },
      { name: "1.5 л", sku: "DRINK-WATER-15", ean: 10, priceMnt: 2_000, costMnt: 1_350 },
      { name: "5 л", sku: "DRINK-WATER-5", ean: 11, priceMnt: 4_500, costMnt: 3_100 },
    ],
  },
  {
    name: "Кока-Кола",
    category: DRINKS,
    unit: "PIECE",
    optionName: "Хэмжээ",
    variants: [
      { name: "0.5 л", sku: "DRINK-COLA-05", ean: 12, priceMnt: 2_800, costMnt: 2_000 },
      { name: "1.25 л", sku: "DRINK-COLA-125", ean: 13, priceMnt: 4_500, costMnt: 3_300 },
    ],
  },
  piece("Жимсний шүүс 1 л", DRINKS, "DRINK-JUICE-1L", 14, 6_200, 4_600),
  piece("Сүүтэй цай 0.5 л", DRINKS, "DRINK-MILKTEA-05", 15, 3_000, 2_100),
  // Sweets.
  piece("Шоколад 100 г", SWEETS, "SWEET-CHOCOLATE-100", 16, 5_500, 4_100),
  piece("Жигнэмэг", SWEETS, "SWEET-COOKIES", 17, 3_800, 2_800),
  kg("Чихэр (жингээр)", SWEETS, "SWEET-CANDY-KG", "601", 18_000, 13_000),
  piece("Зайрмаг", SWEETS, "SWEET-ICECREAM", 18, 2_500, 1_750),
  // Household.
  piece("Угаалгын нунтаг 1 кг", HOUSEHOLD, "HOME-DETERGENT-1KG", 19, 9_500, 7_200),
  piece("Ариун цэврийн цаас 4 ш", HOUSEHOLD, "HOME-TOILET-4", 20, 5_800, 4_300),
  piece("Гарын саван", HOUSEHOLD, "HOME-SOAP", 21, 2_200, 1_550),
  piece("Аяга угаагч шингэн", HOUSEHOLD, "HOME-DISHSOAP", 22, 4_800, 3_500),
  // Services (never stock-tracked).
  {
    name: "Хүргэлт",
    category: SERVICES,
    unit: "PIECE",
    type: "SERVICE",
    variants: [{ sku: "SERVICE-DELIVERY", priceMnt: 5_000, costMnt: 0 }],
  },
];
