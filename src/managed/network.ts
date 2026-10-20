import { isIPv4 } from "node:net";

export interface NetworkSummary {
  name: string;
  subnets: string[];
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function inSubnet(address: string, subnet: string): boolean {
  const [base, bits] = subnet.split("/");
  if (base === undefined || !isIPv4(base) || !isIPv4(address)) return false;
  const prefix = Number(bits ?? 32);
  const size = 2 ** (32 - prefix);
  return Math.floor(ipv4ToNumber(address) / size) === Math.floor(ipv4ToNumber(base) / size);
}

// The network hattisar itself is attached to, found from its own addresses. Docker refuses
// overlapping subnets between networks, so an address matches at most one.
export function networkFor(networks: NetworkSummary[], addresses: string[]): string | undefined {
  return networks.find((network) =>
    network.subnets.some((subnet) => addresses.some((address) => inSubnet(address, subnet))),
  )?.name;
}
