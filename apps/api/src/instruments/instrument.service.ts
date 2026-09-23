import { Injectable, NotFoundException } from "@nestjs/common";
import { instrumentsRepository } from "@trading-copilot/database";
import type { CreateInstrumentInput } from "@trading-copilot/shared-types";
import type { Instrument } from "@trading-copilot/trading-domain";

@Injectable()
export class InstrumentService {
  list(): Promise<Instrument[]> {
    return instrumentsRepository.listInstruments();
  }

  create(input: CreateInstrumentInput): Promise<Instrument> {
    return instrumentsRepository.createInstrument(input);
  }

  async getById(id: string): Promise<Instrument> {
    const instrument = await instrumentsRepository.getInstrument(id);
    if (!instrument) {
      throw new NotFoundException(`Instrument ${id} not found`);
    }
    return instrument;
  }
}
