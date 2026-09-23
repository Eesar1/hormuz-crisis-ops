export interface HeapItem<T> {
  priority: number;
  value: T;
}

export class MinHeap<T> {
  private items: HeapItem<T>[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: HeapItem<T>): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): HeapItem<T> | undefined {
    if (!this.items.length) return undefined;
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.items.length;
    while (true) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = left + 1;
      if (left < length && this.items[left].priority < this.items[smallest].priority) smallest = left;
      if (right < length && this.items[right].priority < this.items[smallest].priority) smallest = right;
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
      index = smallest;
    }
  }
}
