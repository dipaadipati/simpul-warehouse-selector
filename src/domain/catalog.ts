/**
 * The catalog: products and warehouses, held as data rather than as branches in
 * code. Everything the selector knows about the world lives here and nowhere
 * else, so swapping this file for a database query later touches nothing else.
 *
 * One modelling decision is worth calling out because the dataset invites the
 * wrong one. `coldChain` is a property of the PRODUCT, not of its category.
 * P005 Paracetamol is category "Pharmaceutical" but is stocked in W01 and W05,
 * both general warehouses with no refrigeration. Any rule of the form
 * "category === Pharmaceutical means cold chain" would refuse Paracetamol from
 * the two nearest warehouses and push it to Gresik at 30 km instead of Surabaya
 * at 5 km. Only the two vaccines need a cold chain, and products are the
 * reliable key: P002 and P004 appear only in the five warehouses that have
 * refrigerated storage, so stock and capability already agree with each other.
 */

export interface Product {
  id: string;
  name: string;
  category: string;
  coldChain: boolean;
}

export interface Warehouse {
  id: string;
  city: string;
  distanceKm: number;
  coldStorage: boolean;
  fleet: "standard" | "refrigerated";
  stock: Record<string, number>;
}

export const PRODUCTS: readonly Product[] = [
  { id: "P001", name: "Surgical Gloves (Box of 100)", category: "Medical Supplies", coldChain: false },
  { id: "P002", name: "Vaccine - Hepatitis B (10-dose vial)", category: "Pharmaceutical", coldChain: true },
  { id: "P003", name: "Disposable Syringe (Box of 50)", category: "Medical Supplies", coldChain: false },
  { id: "P004", name: "Vaccine - Tetanus Toxoid (10-dose vial)", category: "Pharmaceutical", coldChain: true },
  { id: "P005", name: "Paracetamol Tablets (Box of 100)", category: "Pharmaceutical", coldChain: false },
];

export const WAREHOUSES: readonly Warehouse[] = [
  { id: "W01", city: "Surabaya", distanceKm: 5, coldStorage: false, fleet: "standard", stock: { P001: 200, P003: 500, P005: 300 } },
  { id: "W02", city: "Surabaya", distanceKm: 12, coldStorage: true, fleet: "standard", stock: { P001: 50, P002: 30, P004: 20 } },
  { id: "W03", city: "Sidoarjo", distanceKm: 25, coldStorage: false, fleet: "standard", stock: { P001: 300, P003: 200 } },
  { id: "W04", city: "Gresik", distanceKm: 30, coldStorage: true, fleet: "refrigerated", stock: { P002: 40, P004: 25, P005: 100 } },
  { id: "W05", city: "Malang", distanceKm: 90, coldStorage: false, fleet: "standard", stock: { P001: 400, P003: 300, P005: 500 } },
  { id: "W06", city: "Malang", distanceKm: 95, coldStorage: true, fleet: "standard", stock: { P002: 20, P004: 30, P003: 100 } },
  { id: "W07", city: "Pasuruan", distanceKm: 45, coldStorage: true, fleet: "refrigerated", stock: { P002: 8, P004: 10, P001: 150 } },
  { id: "W08", city: "Jember", distanceKm: 150, coldStorage: true, fleet: "refrigerated", stock: { P002: 60, P004: 50, P005: 200 } },
];

export function productById(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
